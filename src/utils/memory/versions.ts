import { findGitRoot } from '../git.js'

// Synchronous repo-membership check: findGitRoot climbs the directory tree
// itself, no git subprocess involved. Async callers use dirIsInGitRepo().
export function projectIsInGitRepo(cwd: string): boolean {
  return findGitRoot(cwd) !== null
}
