
export function getExitWorktreeToolPrompt(): string {
  return `Exits the worktree this session created and restores its original cwd on the user's explicit ask (worktrees from by-hand git or earlier sessions are untouched; no-op if none active). keep leaves directory, branch and any attached tmux session (returning its name); remove deletes directory and branch and kills that tmux session. Clears cwd-dependent caches.`
}

