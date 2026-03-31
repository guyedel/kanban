import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeStaleGitLockIfExists } from "../../src/workspace/git-lock-cleanup";
import { createTempDir } from "../utilities/temp-dir";

describe("removeStaleGitLockIfExists", () => {
	let tempDir: { path: string; cleanup: () => void };

	beforeEach(() => {
		tempDir = createTempDir("kanban-lock-test-");
	});

	afterEach(() => {
		tempDir.cleanup();
	});

	it("should remove a stale lock file (older than threshold)", async () => {
		const gitDir = join(tempDir.path, ".git");
		mkdirSync(gitDir, { recursive: true });
		const lockPath = join(gitDir, "index.lock");
		writeFileSync(lockPath, "");

		// Use a very short threshold so the lock is considered stale immediately
		const removed = await removeStaleGitLockIfExists(tempDir.path, 0);
		expect(removed).toBe(true);
	});

	it("should NOT remove a fresh lock file (younger than threshold)", async () => {
		const gitDir = join(tempDir.path, ".git");
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(gitDir, "index.lock"), "");

		// Use a very large threshold — lock is not stale
		const removed = await removeStaleGitLockIfExists(tempDir.path, 999_999_999);
		expect(removed).toBe(false);
	});

	it("should return false when no lock file exists", async () => {
		const gitDir = join(tempDir.path, ".git");
		mkdirSync(gitDir, { recursive: true });

		const removed = await removeStaleGitLockIfExists(tempDir.path);
		expect(removed).toBe(false);
	});

	it("should return false when .git directory does not exist", async () => {
		const removed = await removeStaleGitLockIfExists(join(tempDir.path, "nonexistent"));
		expect(removed).toBe(false);
	});

	it("should handle worktree .git file pointing to git dir", async () => {
		// Simulate a worktree where .git is a file with `gitdir: <path>`
		const actualGitDir = join(tempDir.path, "actual-git-dir");
		mkdirSync(actualGitDir, { recursive: true });
		writeFileSync(join(actualGitDir, "index.lock"), "");

		const worktreePath = join(tempDir.path, "worktree");
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(join(worktreePath, ".git"), `gitdir: ${actualGitDir}\n`);

		const removed = await removeStaleGitLockIfExists(worktreePath, 0);
		expect(removed).toBe(true);
	});

	it("should return false for worktree .git file with no lock", async () => {
		const actualGitDir = join(tempDir.path, "actual-git-dir");
		mkdirSync(actualGitDir, { recursive: true });

		const worktreePath = join(tempDir.path, "worktree");
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(join(worktreePath, ".git"), `gitdir: ${actualGitDir}\n`);

		const removed = await removeStaleGitLockIfExists(worktreePath);
		expect(removed).toBe(false);
	});
});
