export function buildWorktreePrepareNotice(failure: string): string {
  return `${failure}; the worktree is used anyway, so what that command would have set up may be missing.`
}
