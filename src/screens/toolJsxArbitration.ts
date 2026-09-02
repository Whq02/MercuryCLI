import type { SetToolJSXFn } from '../Tool.js'

export type ToolJSXState = Parameters<SetToolJSXFn>[0]

export function resolveToolJSX(prev: ToolJSXState, next: ToolJSXState): ToolJSXState {
  if (next === null) return null
  if (next.clearLocalJSX) return prev?.isLocalJSXCommand ? null : prev
  if (next.clearUnlessLocalJSX) return prev?.isLocalJSXCommand ? prev : null
  if (next.deferIfLocalJSX && prev?.isLocalJSXCommand) return prev
  if (next.jsx === null && !next.shouldHidePromptInput) return null
  return next
}
