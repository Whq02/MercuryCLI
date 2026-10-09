export function buildFrozenWorktreeNotice(worktreeCwd: string, commit: string): string {
  return `Your working directory is ${worktreeCwd}: a worktree of the repository detached at commit ${commit}. It is frozen — no later commit or edit elsewhere moves it — so every file you read and every proof you run there stands on exactly that commit. Nothing you write there reaches any branch.`
}
