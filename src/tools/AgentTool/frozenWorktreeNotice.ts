export function buildFrozenWorktreeNotice(worktreeCwd: string, commit: string): string {
  return `Your working directory is ${worktreeCwd}: a frozen detached worktree at commit ${commit}. No later commit or edit elsewhere moves it, so every file you read and proof you run there reflects that commit. Nothing you write there reaches any branch.`
}
