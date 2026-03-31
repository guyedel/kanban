import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function assertDefined<T>(value: T | null | undefined): T {
	expect(value).not.toBeNull();
	expect(value).not.toBeUndefined();
	return value as T;
}

import { createTempDir } from "../utilities/temp-dir";

const lockedFileSystemMocks = vi.hoisted(() => ({
	withLock: vi.fn(async (_request: unknown, operation: () => Promise<unknown>) => await operation()),
	writeJsonFileAtomic: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	getTaskWorktreesHomePath: vi.fn(),
}));

const taskWorktreePathMocks = vi.hoisted(() => ({
	getWorkspaceFolderLabelForWorktreePath: vi.fn(() => "test-repo"),
}));

const gitUtilsMocks = vi.hoisted(() => ({
	runGit: vi.fn(async () => ({ ok: true, stdout: "", stderr: "", output: "", error: null, exitCode: 0 })),
}));

vi.mock("../../src/fs/locked-file-system.js", () => ({
	lockedFileSystem: {
		withLock: lockedFileSystemMocks.withLock,
		writeJsonFileAtomic: lockedFileSystemMocks.writeJsonFileAtomic,
	},
}));

vi.mock("../../src/state/workspace-state.js", () => ({
	getTaskWorktreesHomePath: workspaceStateMocks.getTaskWorktreesHomePath,
}));

vi.mock("../../src/workspace/task-worktree-path.js", () => ({
	getWorkspaceFolderLabelForWorktreePath: taskWorktreePathMocks.getWorkspaceFolderLabelForWorktreePath,
}));

vi.mock("../../src/workspace/git-utils.js", () => ({
	runGit: gitUtilsMocks.runGit,
}));

import { WorktreeSlotPool } from "../../src/workspace/worktree-slot-pool";

describe("WorktreeSlotPool", () => {
	let tempDir: { path: string; cleanup: () => void };
	let pool: WorktreeSlotPool;

	beforeEach(() => {
		tempDir = createTempDir("kanban-pool-test-");
		workspaceStateMocks.getTaskWorktreesHomePath.mockReturnValue(tempDir.path);
		lockedFileSystemMocks.writeJsonFileAtomic.mockImplementation(async (path: string, data: unknown) => {
			const dir = join(path, "..");
			mkdirSync(dir, { recursive: true });
			writeFileSync(path, JSON.stringify(data, null, 2));
		});
		pool = new WorktreeSlotPool();
	});

	afterEach(() => {
		vi.clearAllMocks();
		tempDir.cleanup();
	});

	describe("initialization", () => {
		it("should create pool with default config", async () => {
			await pool.initialize("/test/repo");

			const stats = pool.getPoolStats();
			expect(stats.total).toBe(0);
			expect(stats.claimed).toBe(0);
		});

		it("should accept custom config", async () => {
			pool = new WorktreeSlotPool({ maxSlots: 5, cleanupStrategy: "hard-reset" });
			await pool.initialize("/test/repo");

			const state = pool._getInternalState();
			expect(state?.config.maxSlots).toBe(5);
			expect(state?.config.cleanupStrategy).toBe("hard-reset");
		});

		it("should load persisted state from pool.json", async () => {
			const repoPath = "/test/repo";
			await pool.initialize(repoPath);

			// Create a state with an existing slot
			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "unclaimed",
				baseRef: "main",
				lastClaimedAt: 1000,
				lastReleasedAt: 2000,
				failureCount: 0,
			};
			await pool.shutdown();

			// Re-initialize — should load persisted state
			const pool2 = new WorktreeSlotPool();
			await pool2.initialize(repoPath);

			const stats = pool2.getPoolStats();
			expect(stats.total).toBe(1);
			expect(stats.unclaimed).toBe(1);
		});
	});

	describe("claimSlot", () => {
		it("should create new slot when pool is empty", async () => {
			await pool.initialize("/test/repo");

			const result = await pool.claimSlot("task-1", "main");
			expect(result.slotId).toBe("slot-0");
			expect(result.isNew).toBe(true);
			expect(result.wasAlreadyClaimed).toBe(false);

			const stats = pool.getPoolStats();
			expect(stats.total).toBe(1);
			expect(stats.claimed).toBe(1);
		});

		it("should assign unique slots to different tasks", async () => {
			await pool.initialize("/test/repo");

			const r1 = await pool.claimSlot("task-1", "main");
			const r2 = await pool.claimSlot("task-2", "main");

			expect(r1.slotId).toBe("slot-0");
			expect(r2.slotId).toBe("slot-1");
			expect(r1.slotId).not.toBe(r2.slotId);
		});

		it("should be idempotent for the same task", async () => {
			await pool.initialize("/test/repo");

			const r1 = await pool.claimSlot("task-1", "main");
			const r2 = await pool.claimSlot("task-1", "main");

			expect(r1.slotId).toBe(r2.slotId);
			expect(r2.wasAlreadyClaimed).toBe(true);
		});

		it("should throw when all slots are claimed", async () => {
			pool = new WorktreeSlotPool({ maxSlots: 2 });
			await pool.initialize("/test/repo");

			await pool.claimSlot("task-1", "main");
			await pool.claimSlot("task-2", "main");

			await expect(pool.claimSlot("task-3", "main")).rejects.toThrow("All 2 worktree slots are in use");
		});

		it("should reuse unclaimed slot", async () => {
			await pool.initialize("/test/repo");

			// Manually set up an unclaimed slot and persist to disk
			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "unclaimed",
				baseRef: "main",
				lastClaimedAt: null,
				lastReleasedAt: null,
				failureCount: 0,
			};
			await pool.shutdown();

			const result = await pool.claimSlot("task-1", "main");
			expect(result.slotId).toBe("slot-0");
			expect(result.wasAlreadyClaimed).toBe(false);
		});

		it("should prefer unclaimed slot with matching baseRef", async () => {
			await pool.initialize("/test/repo");

			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "unclaimed",
				baseRef: "develop",
				lastClaimedAt: null,
				lastReleasedAt: 100,
				failureCount: 0,
			};
			state.slots["slot-1"] = {
				slotId: "slot-1",
				taskId: null,
				status: "unclaimed",
				baseRef: "main",
				lastClaimedAt: null,
				lastReleasedAt: 200,
				failureCount: 0,
			};
			await pool.shutdown();

			const result = await pool.claimSlot("task-1", "main");
			expect(result.slotId).toBe("slot-1");
		});

		it("should prefer released slot when no unclaimed available", async () => {
			pool = new WorktreeSlotPool({ maxSlots: 1 });
			await pool.initialize("/test/repo");

			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "released",
				baseRef: "main",
				lastClaimedAt: 100,
				lastReleasedAt: 200,
				failureCount: 0,
			};
			state.pendingCleanups = ["slot-0"];
			await pool.shutdown();

			const result = await pool.claimSlot("task-1", "main");
			expect(result.slotId).toBe("slot-0");
			expect(pool.getPoolStats().pendingCleanups).toBe(0);
		});

		it("should claim corrupted slot as last resort", async () => {
			pool = new WorktreeSlotPool({ maxSlots: 1 });
			await pool.initialize("/test/repo");

			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "corrupted",
				baseRef: null,
				lastClaimedAt: null,
				lastReleasedAt: null,
				failureCount: 3,
			};
			await pool.shutdown();

			const result = await pool.claimSlot("task-1", "main");
			expect(result.slotId).toBe("slot-0");
		});

		it("should update taskToSlot mapping", async () => {
			await pool.initialize("/test/repo");

			await pool.claimSlot("task-1", "main");

			const slot = pool.getSlotForTask("task-1");
			expect(slot).not.toBeNull();
			expect(slot?.slotId).toBe("slot-0");
			expect(slot?.status).toBe("claimed");
			expect(slot?.taskId).toBe("task-1");
		});
	});

	describe("releaseSlot", () => {
		it("should mark slot as released", async () => {
			await pool.initialize("/test/repo");
			await pool.claimSlot("task-1", "main");

			await pool.releaseSlot("task-1");

			const slot = pool.getSlotForTask("task-1");
			expect(slot).toBeNull();

			const stats = pool.getPoolStats();
			expect(stats.released).toBe(1);
			expect(stats.claimed).toBe(0);
		});

		it("should add to pending cleanups", async () => {
			await pool.initialize("/test/repo");
			await pool.claimSlot("task-1", "main");

			await pool.releaseSlot("task-1");

			const stats = pool.getPoolStats();
			expect(stats.pendingCleanups).toBe(1);
		});

		it("should be idempotent for unknown task", async () => {
			await pool.initialize("/test/repo");

			// Should not throw
			await pool.releaseSlot("non-existent-task");
		});

		it("should clear taskToSlot mapping", async () => {
			await pool.initialize("/test/repo");
			await pool.claimSlot("task-1", "main");
			await pool.releaseSlot("task-1");

			const state = assertDefined(pool._getInternalState());
			expect(state.taskToSlot["task-1"]).toBeUndefined();
		});
	});

	describe("cleanup", () => {
		it("should mark slot as unclaimed after successful cleanup", async () => {
			gitUtilsMocks.runGit.mockResolvedValue({
				ok: true,
				stdout: "",
				stderr: "",
				output: "",
				error: null,
				exitCode: 0,
			});
			await pool.initialize("/test/repo");

			const slotPath = pool.slotWorktreePath("slot-0");
			mkdirSync(slotPath, { recursive: true });

			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "released",
				baseRef: "main",
				lastClaimedAt: 100,
				lastReleasedAt: 200,
				failureCount: 0,
			};
			state.pendingCleanups = ["slot-0"];
			await pool.shutdown();

			// Re-initialize to trigger cleanup queue processing
			pool = new WorktreeSlotPool();
			await pool.initialize("/test/repo");

			// Wait a tick for async cleanup
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Cleanup should have been attempted
			expect(gitUtilsMocks.runGit).toHaveBeenCalled();
		});

		it("should increment failureCount on cleanup failure", async () => {
			gitUtilsMocks.runGit.mockRejectedValue(new Error("git failed"));
			await pool.initialize("/test/repo");

			const slotPath = pool.slotWorktreePath("slot-0");
			mkdirSync(slotPath, { recursive: true });

			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "released",
				baseRef: "main",
				lastClaimedAt: 100,
				lastReleasedAt: 200,
				failureCount: 0,
			};
			state.pendingCleanups = ["slot-0"];
			await pool.shutdown();

			// Re-initialize to trigger cleanup
			pool = new WorktreeSlotPool();
			await pool.initialize("/test/repo");

			// Wait for async cleanup
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
	});

	describe("getSlotForTask", () => {
		it("should return null for unknown task", async () => {
			await pool.initialize("/test/repo");

			expect(pool.getSlotForTask("unknown")).toBeNull();
		});

		it("should return slot state for claimed task", async () => {
			await pool.initialize("/test/repo");
			await pool.claimSlot("task-1", "main");

			const slot = pool.getSlotForTask("task-1");
			expect(slot).not.toBeNull();
			expect(slot?.slotId).toBe("slot-0");
			expect(slot?.taskId).toBe("task-1");
			expect(slot?.baseRef).toBe("main");
		});
	});

	describe("getPoolStats", () => {
		it("should report correct counts", async () => {
			await pool.initialize("/test/repo");

			await pool.claimSlot("task-1", "main");
			await pool.claimSlot("task-2", "main");

			const stats = pool.getPoolStats();
			expect(stats.total).toBe(2);
			expect(stats.claimed).toBe(2);
			expect(stats.unclaimed).toBe(0);
			expect(stats.released).toBe(0);
			expect(stats.corrupted).toBe(0);
		});

		it("should return zeros for uninitialized pool", () => {
			const uninitPool = new WorktreeSlotPool();
			const stats = uninitPool.getPoolStats();
			expect(stats.total).toBe(0);
		});
	});

	describe("validateIntegrity", () => {
		it("should detect stale taskToSlot mappings", async () => {
			await pool.initialize("/test/repo");

			const state = assertDefined(pool._getInternalState());
			state.taskToSlot["orphan-task"] = "non-existent-slot";

			const result = await pool.validateIntegrity();
			expect(result.valid).toBe(false);
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0]).toContain("orphan-task");
		});

		it("should detect released slots missing from cleanup queue", async () => {
			await pool.initialize("/test/repo");

			const slotPath = pool.slotWorktreePath("slot-0");
			mkdirSync(slotPath, { recursive: true });

			const state = assertDefined(pool._getInternalState());
			state.slots["slot-0"] = {
				slotId: "slot-0",
				taskId: null,
				status: "released",
				baseRef: "main",
				lastClaimedAt: 100,
				lastReleasedAt: 200,
				failureCount: 0,
			};
			state.pendingCleanups = [];

			const result = await pool.validateIntegrity();
			expect(result.valid).toBe(false);
			expect(result.issues.some((i) => i.includes("released but not in cleanup queue"))).toBe(true);
		});

		it("should return valid for empty pool", async () => {
			await pool.initialize("/test/repo");

			const result = await pool.validateIntegrity();
			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});
	});

	describe("shutdown", () => {
		it("should persist state on shutdown", async () => {
			await pool.initialize("/test/repo");
			await pool.claimSlot("task-1", "main");

			await pool.shutdown();

			expect(lockedFileSystemMocks.writeJsonFileAtomic).toHaveBeenCalled();
		});
	});

	describe("slot path construction", () => {
		it("should construct correct worktree path for slot", async () => {
			await pool.initialize("/test/repo");

			const path = pool.slotWorktreePath("slot-0");
			expect(path).toContain(".pools");
			expect(path).toContain("slot-0");
			expect(path).toContain("test-repo");
		});
	});

	describe("config", () => {
		it("should respect custom maxSlots", async () => {
			pool = new WorktreeSlotPool({ maxSlots: 1 });
			await pool.initialize("/test/repo");

			await pool.claimSlot("task-1", "main");
			await expect(pool.claimSlot("task-2", "main")).rejects.toThrow("in use");
		});

		it("should default to 3 maxSlots", async () => {
			await pool.initialize("/test/repo");

			await pool.claimSlot("task-1", "main");
			await pool.claimSlot("task-2", "main");
			await pool.claimSlot("task-3", "main");

			const stats = pool.getPoolStats();
			expect(stats.total).toBe(3);
			expect(stats.claimed).toBe(3);
		});
	});

	describe("error handling", () => {
		it("should throw when not initialized", async () => {
			const uninitPool = new WorktreeSlotPool();

			await expect(uninitPool.claimSlot("task-1", "main")).rejects.toThrow("not initialized");
		});

		it("should throw when pool is exhausted with correct error message", async () => {
			pool = new WorktreeSlotPool({ maxSlots: 2 });
			await pool.initialize("/test/repo");

			await pool.claimSlot("task-1", "main");
			await pool.claimSlot("task-2", "main");

			await expect(pool.claimSlot("task-3", "main")).rejects.toThrow(/All 2 worktree slots are in use.*max: 2/);
		});
	});
});
