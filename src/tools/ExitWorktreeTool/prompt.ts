
export function getExitWorktreeToolPrompt(): string {
  return `Ends the worktree session this session started and restores its original working directory, on the user's explicit ask; a worktree created by hand or by a previous session is untouched, and with no active worktree session the call says so and touches nothing. keep leaves the worktree directory and its branch on disk, and a tmux session attached to the worktree keeps running with its name returned for the user; remove deletes both and kills that tmux session. Caches that depend on the working directory are cleared.`
}

