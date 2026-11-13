import { CHECKPOINT_TOOL_NAME } from '../../services/compact/checkpointRewind.js'

export { CHECKPOINT_TOOL_NAME }

export const DESCRIPTION =
  'Mark the current conversation state before an exploratory detour, so Rewind can restore it later.'

export const CHECKPOINT_TOOL_PROMPT = `Marks the current conversation state for a later rewind before an exploratory detour (echoing goal back at rewind). Only one checkpoint may be active at a time; ending a run with one active emits a settle warning. Context-only: files, git state and the operator's visible transcript are untouched.`
