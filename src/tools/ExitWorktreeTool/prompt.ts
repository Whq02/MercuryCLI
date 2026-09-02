/**
 * The ExitWorktree tool's model-facing prompt. The tool-name constant lives
 * in the sibling constants file; the enter tool's name is referenced there.
 */

export function getExitWorktreeToolPrompt(): string {
  return `Ends a worktree session that was started with the EnterWorktree tool and returns the session to the original directory.

Scope — this tool will NOT touch:
- worktrees created by hand (git worktree add, scripts, other tools)
- worktrees created by the EnterWorktree tool in a PREVIOUS session
- the current directory when EnterWorktree was never called this session
Outside an active worktree session the call does nothing: it answers that no session is active and touches no files.

When to use:
- ONLY on the user's explicit ask to exit or leave the worktree, or to return to the original directory. Never proactively.

Parameters:
- action: "keep" preserves the worktree directory and branch on disk — use it when the user may return to the work or has changes worth preserving. "remove" deletes both the directory and the branch — the clean exit for finished or abandoned work.
- discard_changes (default false): only meaningful with action "remove". It must be true when uncommitted files or unmerged commits sit in the worktree; otherwise the tool refuses and lists what it found. Get the user's word before re-invoking with discard_changes: true.

Behavior:
- The session's working directory is restored to the original directory.
- Caches that depend on the working directory are cleared.
- A tmux session attached to the worktree is killed on "remove"; on "keep" it keeps running, its name coming back for the user to reattach.
- EnterWorktree can be called again afterwards to start a new worktree session.`
}
