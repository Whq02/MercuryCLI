// The single arbiter of the shared toolJSX slot (one owner — law 6). The
// slot is written by tool progress renders, local-JSX slash commands, and
// foreground `!` bash progress; when two writers race the arbitration here
// decides which survives. Pure so the prover drives the whole table without
// a rendered capture.
import type { SetToolJSXFn } from '../Tool.js'

export type ToolJSXState = Parameters<SetToolJSXFn>[0]

/**
 * Resolve the next slot value from the previous one and an incoming write.
 *
 * Ownership rules:
 *  - `null` clears the slot outright.
 *  - `clearLocalJSX` clears only a local-JSX command (a slash-command
 *    dialog), leaving anything else — the slash owner tearing down its own.
 *  - `clearUnlessLocalJSX` clears UNLESS a local-JSX dialog now owns the
 *    slot: a foreground `!` command tearing down its own progress must not
 *    destroy a permission/slash dialog that opened over it while it ran.
 *  - `deferIfLocalJSX` yields to a local-JSX dialog already in the slot: a
 *    `!` command's periodic progress render must not clobber that dialog.
 *  - the empty-clear: a null jsx that also frees the prompt
 *    clears the slot.
 */
export function resolveToolJSX(prev: ToolJSXState, next: ToolJSXState): ToolJSXState {
  if (next === null) return null
  if (next.clearLocalJSX) return prev?.isLocalJSXCommand ? null : prev
  if (next.clearUnlessLocalJSX) return prev?.isLocalJSXCommand ? prev : null
  if (next.deferIfLocalJSX && prev?.isLocalJSXCommand) return prev
  if (next.jsx === null && !next.shouldHidePromptInput) return null
  return next
}
