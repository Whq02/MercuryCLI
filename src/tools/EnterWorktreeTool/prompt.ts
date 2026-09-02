// EnterWorktree usage doctrine: explicit-request-only.

export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree'

export function getEnterWorktreeToolPrompt(): string {
  return `Split off an isolated git worktree and move this session into it.

## When it applies
ONLY on the word "worktree" from the user — e.g. "work in a worktree", "make a worktree for this", "do it in a separate worktree".

## When NOT to use
- Creating or switching branches — use git directly.
- Ordinary feature or bugfix work, however large.
- Never unless the user explicitly asked for a worktree.

## Requirements
- A git repository, or configured WorktreeCreate/WorktreeRemove hooks.
- The session is not already in a worktree it created.

## Behaviour
Inside a repository, a new worktree is created under the project config home's worktrees directory (\`.mercury/worktrees/\`) on a new branch based on the current head. Outside one, the configured hooks provide VCS-agnostic isolation. The session's working directory switches into the worktree. Leave mid-session with the exit tool (keep-or-remove choice); ending the session also prompts.

## Parameters
- \`name\` (optional): the worktree name. Within each slash-delimited segment the permitted characters are letters, digits, and the dot/underscore/dash trio; the whole name may not exceed 64 characters. Omitted, a random name is generated.`
}
