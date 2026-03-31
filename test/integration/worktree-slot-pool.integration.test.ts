import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { slotPoolRegistry } from "../../src/workspace/worktree-slot-pool";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed in ${cwd}`, result.stdout.trim(), result.stderr.trim()]
				.filter((part) => part.length > 0)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

function createTestRepo(parentDir: string): { repoPath: string; branch: string } {
	const repoPath = join(parentDir, "repo");
	mkdirSync(repoPath, { recursive: true });
	runGit(repoPath, ["init"]);
	runGit(repoPath, ["config", "user.name", "Kanban Test"]);
	runGit(repoPath, ["config", "user.email", "kanban-test@example.com"]);
	writeFileSync(join(repoPath, "README.md"), "# Test Repo\n");
	runGit(repoPath, ["add", "."]);
	runGit(repoPath, ["commit", "-m", "initial commit"]);
	const branch = runGit(repoPath, ["symbolic-ref", "--short", "HEAD"]);
	return { repoPath, branch };
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-pool-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;

	// Clear the pool registry between tests
	slotPoolRegistry.clear();

	try {
		return await run();
	} finally {
		slotPoolRegistry.clear();
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

describe.sequential("worktree-slot-pool integration", () => {
	it("should create a worktree in a pool slot on first task start", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				const result = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});

				expect(result.ok).toBe(true);
				expect(result.path).toBeTruthy();
				expect(result.path).toContain(".pools");
				expect(result.path).toContain("slot-0");
				expect(existsSync(result.path as string)).toBe(true);

				// Verify it's a real git worktree
				const head = runGit(result.path as string, ["rev-parse", "HEAD"]);
				expect(head).toBeTruthy();
			} finally {
				cleanup();
			}
		});
	});

	it("should be idempotent — repeated ensure returns the same slot", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				const r1 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});

				const r2 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});

				expect(r1.ok).toBe(true);
				expect(r2.ok).toBe(true);
				expect(r1.path).toBe(r2.path);
			} finally {
				cleanup();
			}
		});
	});

	it("should assign different slots to different tasks", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				const r1 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				const r2 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-2",
					baseRef: branch,
				});

				expect(r1.ok).toBe(true);
				expect(r2.ok).toBe(true);
				expect(r1.path).not.toBe(r2.path);
				expect(r1.path).toContain("slot-0");
				expect(r2.path).toContain("slot-1");
			} finally {
				cleanup();
			}
		});
	});

	it("should reuse slot after task is deleted (full lifecycle)", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				// Create task-1 worktree
				const r1 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				expect(r1.ok).toBe(true);

				// Create a file in the worktree to verify cleanup
				writeFileSync(join(r1.path as string, "task1-work.txt"), "task 1 work");
				expect(existsSync(join(r1.path as string, "task1-work.txt"))).toBe(true);

				// Delete task-1 (releases the slot)
				const delResult = await deleteTaskWorktree({
					repoPath,
					taskId: "task-1",
				});
				expect(delResult.ok).toBe(true);
				expect(delResult.removed).toBe(true);

				// Slot directory should still exist (not deleted, just released)
				expect(existsSync(r1.path as string)).toBe(true);

				// Start task-2 — should reuse the slot
				const r2 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-2",
					baseRef: branch,
				});

				expect(r2.ok).toBe(true);
				// Should reuse slot-0 since it was released
				expect(r2.path).toContain("slot-0");

				// The old task's file should be gone after slot reset
				expect(existsSync(join(r2.path as string, "task1-work.txt"))).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("should preserve symlinked ignored paths after slot reuse", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				// Create a node_modules directory in main repo (typically gitignored)
				const nodeModulesPath = join(repoPath, "node_modules");
				mkdirSync(nodeModulesPath, { recursive: true });
				writeFileSync(join(nodeModulesPath, "marker.txt"), "node_modules present");

				// Add node_modules to .gitignore
				writeFileSync(join(repoPath, ".gitignore"), "node_modules/\n");
				runGit(repoPath, ["add", ".gitignore"]);
				runGit(repoPath, ["commit", "-m", "add gitignore"]);

				// Create first task
				const r1 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				expect(r1.ok).toBe(true);

				// Check that node_modules is symlinked in the worktree
				const worktreeNodeModules = join(r1.path as string, "node_modules");
				if (existsSync(worktreeNodeModules)) {
					expect(lstatSync(worktreeNodeModules).isSymbolicLink()).toBe(true);
				}

				// Delete and re-create to test symlink survival
				await deleteTaskWorktree({ repoPath, taskId: "task-1" });
				const r2 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-2",
					baseRef: branch,
				});
				expect(r2.ok).toBe(true);

				// Symlink should be re-established after slot reuse
				const worktreeNodeModules2 = join(r2.path as string, "node_modules");
				if (existsSync(worktreeNodeModules2)) {
					expect(lstatSync(worktreeNodeModules2).isSymbolicLink()).toBe(true);
				}
			} finally {
				cleanup();
			}
		});
	});

	it("should capture and restore patches across slot reuse", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				// Create task-1 worktree
				const r1 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				expect(r1.ok).toBe(true);

				// Add a tracked modification in the worktree
				writeFileSync(join(r1.path as string, "README.md"), "# Modified by task-1\n");

				// Delete task (captures patch)
				await deleteTaskWorktree({ repoPath, taskId: "task-1" });

				// Re-create task-1 (should restore patch from trashed-task-patches)
				const r2 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				expect(r2.ok).toBe(true);

				// The patch should have been applied — file should have the modification
				const content = spawnSync("cat", [join(r2.path as string, "README.md")], { encoding: "utf8" });
				expect(content.stdout).toContain("Modified by task-1");
			} finally {
				cleanup();
			}
		});
	});

	it("should report error when all slots are exhausted", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				// Create 3 tasks (default maxSlots = 3)
				for (let i = 1; i <= 3; i++) {
					const result = await ensureTaskWorktreeIfDoesntExist({
						cwd: repoPath,
						taskId: `task-${i}`,
						baseRef: branch,
					});
					expect(result.ok).toBe(true);
				}

				// Fourth task should fail with pool exhaustion error
				const r4 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-4",
					baseRef: branch,
				});
				expect(r4.ok).toBe(false);
				expect(r4.error).toContain("slots are in use");
			} finally {
				cleanup();
			}
		});
	});

	it("should handle pool state persistence across pool restarts", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-pool-");
			try {
				const { repoPath, branch } = createTestRepo(sandboxRoot);

				// Create a task
				const r1 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				expect(r1.ok).toBe(true);

				// Simulate server restart by clearing the pool registry
				const pool = slotPoolRegistry.get(repoPath);
				if (pool) {
					await pool.shutdown();
				}
				slotPoolRegistry.clear();

				// Re-create task-1 — should find the existing slot from pool.json
				const r2 = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId: "task-1",
					baseRef: branch,
				});
				expect(r2.ok).toBe(true);
				expect(r2.path).toBe(r1.path);
			} finally {
				cleanup();
			}
		});
	});
});
