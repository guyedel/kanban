import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_STALE_THRESHOLD_MS = 30_000;

/**
 * Resolves the git directory for a working tree path.
 * For worktrees, `.git` is a file containing `gitdir: /path/to/git-dir`.
 * For normal repos, `.git` is the directory itself.
 */
async function resolveGitDir(worktreePath: string): Promise<string | null> {
	const dotGitPath = join(worktreePath, ".git");
	try {
		const info = await stat(dotGitPath);
		if (info.isDirectory()) {
			return dotGitPath;
		}
		// Worktree: .git is a file with `gitdir: <path>`
		const content = await readFile(dotGitPath, "utf8");
		const match = content.match(/^gitdir:\s*(.+)/);
		return match?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

/**
 * Removes a stale `index.lock` file from a git working tree if it exists
 * and is older than the staleness threshold (default 30 seconds).
 *
 * Git operations normally complete in under 1 second, so any lock file
 * older than 30 seconds is safely considered abandoned (crashed process).
 */
export async function removeStaleGitLockIfExists(
	worktreePath: string,
	maxAgeMs: number = DEFAULT_STALE_THRESHOLD_MS,
): Promise<boolean> {
	const gitDir = await resolveGitDir(worktreePath);
	if (!gitDir) {
		return false;
	}
	const lockPath = join(gitDir, "index.lock");
	try {
		const lockStat = await stat(lockPath);
		const ageMs = Date.now() - lockStat.mtimeMs;
		if (maxAgeMs > 0 && ageMs < maxAgeMs) {
			return false;
		}
		await unlink(lockPath);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error) {
			const code = (error as { code: string }).code;
			if (code === "ENOENT") {
				return false;
			}
		}
		// EACCES or other errors — silently skip, don't block the operation
		return false;
	}
}
