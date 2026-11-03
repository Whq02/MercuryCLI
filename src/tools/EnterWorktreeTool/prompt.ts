
export function getEnterWorktreeToolPrompt(): string {
  return `Creates an isolated git worktree under the project's \`.mercury/worktrees/\` on a new branch from the current head — outside a repository the configured hooks provide the isolation — and moves this session's working directory into it, on the user's word "worktree" only; a session already in a worktree it created stays where it is. The session ends with a keep-or-remove prompt for the worktree.`
}

