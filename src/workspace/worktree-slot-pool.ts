import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { WorktreePoolConfigShape } from "../config/runtime-config";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { runGit } from "./git-utils";
import { getWorkspaceFolderLabelForWorktreePath } from "./task-worktree-path";

// --- Types ---

export interface PoolConfig {
	maxSlots: number;
	cleanupStrategy: "checkout-clean" | "hard-reset";
}

export type SlotStatus = "unclaimed" | "claimed" | "released" | "corrupted";

export interface SlotState {
	slotId: string;
	taskId: string | null;
	status: SlotStatus;
	baseRef: string | null;
	lastClaimedAt: number | null;
	lastReleasedAt: number | null;
	failureCount: number;
}

export interface PoolPersistenceState {
	version: 1;
	repoPath: string;
	config: PoolConfig;
	slots: Record<string, SlotState>;
	taskToSlot: Record<string, string>;
	pendingCleanups: string[];
}

export interface SlotClaimResult {
	slotId: string;
	path: string;
	isNew: boolean;
	wasAlreadyClaimed: boolean;
}

export interface PoolStats {
	total: number;
	claimed: number;
	unclaimed: number;
	released: number;
	corrupted: number;
	pendingCleanups: number;
}

export interface PoolValidationResult {
	valid: boolean;
	issues: string[];
}

// --- Errors ---

export class PoolExhaustedError extends Error {
	readonly maxSlots: number;
	constructor(currentSlots: number, maxSlots: number) {
		super(
			`All ${currentSlots} worktree slots are in use. ` +
				`Complete or trash a task to free a slot. (max: ${maxSlots})`,
		);
		this.name = "PoolExhaustedError";
		this.maxSlots = maxSlots;
	}
}

// --- Constants ---

export const DEFAULT_POOL_CONFIG: PoolConfig = {
	maxSlots: 3,
	cleanupStrategy: "checkout-clean",
};

const POOLS_DIR = ".pools";
const POOL_STATE_FILE = "pool.json";
const POOL_LOCK_FILE = "pool.lock";
const MAX_CLEANUP_FAILURES = 3;

// --- Path helpers ---

export function repoHash(repoPath: string): string {
	return createHash("sha256").update(repoPath).digest("hex").slice(0, 8);
}

function poolRoot(repoPath: string): string {
	return join(getTaskWorktreesHomePath(), POOLS_DIR, repoHash(repoPath));
}

function poolStatePath(repoPath: string): string {
	return join(poolRoot(repoPath), POOL_STATE_FILE);
}

function poolLock(repoPath: string): LockRequest {
	return { type: "directory", path: poolRoot(repoPath), lockfileName: POOL_LOCK_FILE };
}

function slotLock(slotDir: string): LockRequest {
	return { type: "directory", path: slotDir, lockfileName: ".lock" };
}

async function fsExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function createSlotState(slotId: string): SlotState {
	return {
		slotId,
		taskId: null,
		status: "unclaimed",
		baseRef: null,
		lastClaimedAt: null,
		lastReleasedAt: null,
		failureCount: 0,
	};
}

// --- Pool class ---

export class WorktreeSlotPool {
	private repoPath = "";
	private config: PoolConfig;
	private state: PoolPersistenceState | null = null;
	private ready = false;

	constructor(config?: Partial<PoolConfig>) {
		this.config = { ...DEFAULT_POOL_CONFIG, ...config };
	}

	async initialize(repoPath: string, config?: Partial<PoolConfig>): Promise<void> {
		this.repoPath = repoPath;
		if (config) {
			this.config = { ...this.config, ...config };
		}
		await this.loadState();
		this.ready = true;
		void this.processCleanupQueue();
	}

	async shutdown(): Promise<void> {
		if (this.state) {
			await this.saveState();
		}
	}

	async claimSlot(taskId: string, baseRef: string): Promise<SlotClaimResult> {
		this.ensureReady();

		return await lockedFileSystem.withLock(poolLock(this.repoPath), async () => {
			await this.loadState();
			const s = this.activeState;

			// Idempotent: task already has a claimed slot
			const existingSlotId = s.taskToSlot[taskId];
			if (existingSlotId && s.slots[existingSlotId]?.status === "claimed") {
				return {
					slotId: existingSlotId,
					path: this.slotWorktreePath(existingSlotId),
					isNew: false,
					wasAlreadyClaimed: true,
				};
			}

			const slot = this.pickSlot(baseRef);
			if (!slot) {
				throw new PoolExhaustedError(Object.keys(s.slots).length, this.config.maxSlots);
			}

			slot.taskId = taskId;
			slot.status = "claimed";
			slot.baseRef = baseRef;
			slot.lastClaimedAt = Date.now();
			s.taskToSlot[taskId] = slot.slotId;
			s.pendingCleanups = s.pendingCleanups.filter((id) => id !== slot.slotId);

			const path = this.slotWorktreePath(slot.slotId);
			const isNew = !(await fsExists(path));

			await this.saveState();
			return { slotId: slot.slotId, path, isNew, wasAlreadyClaimed: false };
		});
	}

	async releaseSlot(taskId: string): Promise<void> {
		this.ensureReady();

		await lockedFileSystem.withLock(poolLock(this.repoPath), async () => {
			await this.loadState();
			const s = this.activeState;

			const slotId = s.taskToSlot[taskId];
			if (!slotId) {
				return;
			}

			const slot = s.slots[slotId];
			if (slot) {
				slot.taskId = null;
				slot.status = "released";
				slot.lastReleasedAt = Date.now();
				if (!s.pendingCleanups.includes(slotId)) {
					s.pendingCleanups.push(slotId);
				}
			}

			delete s.taskToSlot[taskId];
			await this.saveState();
		});

		void this.processCleanupQueue();
	}

	getSlotForTask(taskId: string): SlotState | null {
		if (!this.state) {
			return null;
		}
		const slotId = this.state.taskToSlot[taskId];
		return slotId ? (this.state.slots[slotId] ?? null) : null;
	}

	slotWorktreePath(slotId: string): string {
		return join(poolRoot(this.repoPath), slotId, getWorkspaceFolderLabelForWorktreePath(this.repoPath));
	}

	slotRootPath(slotId: string): string {
		return join(poolRoot(this.repoPath), slotId);
	}

	getPoolStats(): PoolStats {
		if (!this.state) {
			return { total: 0, claimed: 0, unclaimed: 0, released: 0, corrupted: 0, pendingCleanups: 0 };
		}
		const all = Object.values(this.state.slots);
		return {
			total: all.length,
			claimed: all.filter((s) => s.status === "claimed").length,
			unclaimed: all.filter((s) => s.status === "unclaimed").length,
			released: all.filter((s) => s.status === "released").length,
			corrupted: all.filter((s) => s.status === "corrupted").length,
			pendingCleanups: this.state.pendingCleanups.length,
		};
	}

	async validateIntegrity(): Promise<PoolValidationResult> {
		this.ensureReady();
		const issues: string[] = [];
		const s = this.activeState;

		for (const [id, slot] of Object.entries(s.slots)) {
			const path = this.slotWorktreePath(id);
			if ((slot.status === "claimed" || slot.status === "unclaimed") && !(await fsExists(path))) {
				issues.push(`Slot ${id} is ${slot.status} but directory missing`);
				slot.status = "corrupted";
			}
			if (slot.status === "released" && !s.pendingCleanups.includes(id)) {
				issues.push(`Slot ${id} released but not in cleanup queue`);
				s.pendingCleanups.push(id);
			}
		}

		for (const [taskId, slotId] of Object.entries(s.taskToSlot)) {
			if (!s.slots[slotId] || s.slots[slotId].taskId !== taskId) {
				issues.push(`Stale mapping: task ${taskId} -> slot ${slotId}`);
				delete s.taskToSlot[taskId];
			}
		}

		if (issues.length > 0) {
			await this.saveState();
		}
		return { valid: issues.length === 0, issues };
	}

	/** Exposed for testing only. */
	_getInternalState(): PoolPersistenceState | null {
		return this.state;
	}

	// --- Private ---

	private ensureReady(): void {
		if (!this.ready) {
			throw new Error("WorktreeSlotPool not initialized. Call initialize() first.");
		}
	}

	private get activeState(): PoolPersistenceState {
		if (!this.state) {
			throw new Error("Pool state not loaded.");
		}
		return this.state;
	}

	private async loadState(): Promise<void> {
		const path = poolStatePath(this.repoPath);
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as PoolPersistenceState;
			if (parsed.version === 1) {
				this.state = parsed;
				this.state.config = { ...DEFAULT_POOL_CONFIG, ...parsed.config };
				return;
			}
		} catch {
			// Missing or corrupt file — start fresh
		}
		this.state = {
			version: 1,
			repoPath: this.repoPath,
			config: this.config,
			slots: {},
			taskToSlot: {},
			pendingCleanups: [],
		};
	}

	private async saveState(): Promise<void> {
		if (!this.state) {
			return;
		}
		await lockedFileSystem.writeJsonFileAtomic(poolStatePath(this.repoPath), this.state, { lock: null });
	}

	private pickSlot(baseRef: string): SlotState | null {
		const slots = Object.values(this.activeState.slots);
		const byAge = (a: SlotState, b: SlotState) => (a.lastReleasedAt ?? 0) - (b.lastReleasedAt ?? 0);

		// 1. Unclaimed with matching baseRef
		const matchUnclaimed = slots.filter((s) => s.status === "unclaimed" && s.baseRef === baseRef).sort(byAge);
		if (matchUnclaimed.length > 0) {
			return matchUnclaimed[0] ?? null;
		}

		// 2. Any unclaimed
		const anyUnclaimed = slots.filter((s) => s.status === "unclaimed").sort(byAge);
		if (anyUnclaimed.length > 0) {
			return anyUnclaimed[0] ?? null;
		}

		// 3. Released with matching baseRef
		const matchReleased = slots.filter((s) => s.status === "released" && s.baseRef === baseRef).sort(byAge);
		if (matchReleased.length > 0) {
			return matchReleased[0] ?? null;
		}

		// 4. Any released
		const anyReleased = slots.filter((s) => s.status === "released").sort(byAge);
		if (anyReleased.length > 0) {
			return anyReleased[0] ?? null;
		}

		// 5. Create new slot if under maxSlots
		if (slots.length < this.config.maxSlots) {
			const maxIndex = slots.reduce((max, s) => {
				const m = s.slotId.match(/^slot-(\d+)$/);
				return m?.[1] ? Math.max(max, Number.parseInt(m[1], 10)) : max;
			}, -1);
			const id = `slot-${maxIndex + 1}`;
			const slot = createSlotState(id);
			this.activeState.slots[id] = slot;
			return slot;
		}

		// 6. Corrupted with lowest failure count (will be fully recreated)
		const corrupted = slots.filter((s) => s.status === "corrupted").sort((a, b) => a.failureCount - b.failureCount);
		if (corrupted.length > 0) {
			return corrupted[0] ?? null;
		}

		return null;
	}

	private async cleanupSlot(slotId: string): Promise<void> {
		// Re-check status under pool lock before doing expensive git work
		const shouldClean = await lockedFileSystem.withLock(poolLock(this.repoPath), async () => {
			await this.loadState();
			return this.activeState.slots[slotId]?.status === "released";
		});
		if (!shouldClean) {
			return;
		}

		const slotPath = this.slotWorktreePath(slotId);
		const slotDir = this.slotRootPath(slotId);
		let success = false;

		try {
			await lockedFileSystem.withLock(slotLock(slotDir), async () => {
				if (!(await fsExists(slotPath))) {
					success = true;
					return;
				}
				if (this.config.cleanupStrategy === "checkout-clean") {
					await runGit(slotPath, ["checkout", "--detach"]);
					await runGit(slotPath, ["clean", "-fd"]);
					await runGit(slotPath, ["reset", "--hard", "HEAD"]);
				} else {
					await runGit(slotPath, ["reset", "--hard", "HEAD"]);
					await runGit(slotPath, ["clean", "-fd"]);
				}
				success = true;
			});
		} catch {
			// Tracked via failureCount below
		}

		// Update state under pool lock — re-check status to handle concurrent claim
		await lockedFileSystem.withLock(poolLock(this.repoPath), async () => {
			await this.loadState();
			const slot = this.activeState.slots[slotId];
			if (!slot || slot.status !== "released") {
				return;
			}

			if (success) {
				slot.status = "unclaimed";
				slot.failureCount = 0;
			} else {
				slot.failureCount++;
				if (slot.failureCount >= MAX_CLEANUP_FAILURES) {
					slot.status = "corrupted";
				}
			}
			this.activeState.pendingCleanups = this.activeState.pendingCleanups.filter((id) => id !== slotId);
			await this.saveState();
		});
	}

	private async processCleanupQueue(): Promise<void> {
		if (!this.state) {
			return;
		}
		for (const slotId of [...this.state.pendingCleanups]) {
			try {
				await this.cleanupSlot(slotId);
			} catch {
				// Best-effort — errors tracked in failureCount
			}
		}
	}
}

// --- Global registry ---

export const slotPoolRegistry = new Map<string, WorktreeSlotPool>();

async function resolvePoolKey(repoPath: string): Promise<string> {
	try {
		return await realpath(repoPath);
	} catch {
		return repoPath;
	}
}

export async function getOrCreatePool(
	repoPath: string,
	userConfig?: WorktreePoolConfigShape,
): Promise<WorktreeSlotPool | null> {
	const key = await resolvePoolKey(repoPath);
	if (userConfig?.enabled === false) {
		return null;
	}
	const existing = slotPoolRegistry.get(key);
	if (existing) {
		return existing;
	}
	const poolConfig: Partial<PoolConfig> = {};
	if (userConfig?.maxSlots !== undefined) {
		poolConfig.maxSlots = userConfig.maxSlots;
	}
	if (userConfig?.cleanupStrategy !== undefined) {
		poolConfig.cleanupStrategy = userConfig.cleanupStrategy;
	}
	const pool = new WorktreeSlotPool(poolConfig);
	await pool.initialize(key, poolConfig);
	slotPoolRegistry.set(key, pool);
	return pool;
}

export async function getPoolForPath(repoPath: string): Promise<WorktreeSlotPool | undefined> {
	const key = await resolvePoolKey(repoPath);
	return slotPoolRegistry.get(key);
}

export async function resolveClaimedSlotPath(repoPath: string, taskId: string): Promise<string | null> {
	const pool = await getPoolForPath(repoPath);
	if (!pool) {
		return null;
	}
	const slot = pool.getSlotForTask(taskId);
	if (!slot || slot.status !== "claimed") {
		return null;
	}
	return pool.slotWorktreePath(slot.slotId);
}
