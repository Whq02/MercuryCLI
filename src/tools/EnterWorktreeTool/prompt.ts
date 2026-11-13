
export function getEnterWorktreeToolPrompt(): string {
  return `Creates an isolated git worktree under \`.mercury/worktrees/\` on a new branch from HEAD (outside git, configured hooks isolate) and switches this session's cwd into it — only when the user explicitly says "worktree". Refuses if already in a session-created worktree; prompts keep-or-remove at session end.`
}

