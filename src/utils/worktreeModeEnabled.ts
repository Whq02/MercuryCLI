/**
 * Worktree mode is on for everyone — a constant, on purpose.
 *
 * It once sat behind a feature gate, and the CACHED_MAY_BE_STALE read
 * answered its default (false) on a cold first launch before the cache had
 * filled, which quietly ate --worktree. A constant cannot go stale.
 */
export function isWorktreeModeEnabled(): boolean {
  return true
}
