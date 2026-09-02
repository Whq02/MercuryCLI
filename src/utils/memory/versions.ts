import { findGitRoot } from '../git.js'

export function projectIsInGitRepo(cwd: string): boolean {
  return findGitRoot(cwd) !== null
}
