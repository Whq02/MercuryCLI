import { CHECKPOINT_TOOL_NAME } from '../../services/compact/checkpointRewind.js'

export { CHECKPOINT_TOOL_NAME }

export const DESCRIPTION =
  'Mark the current conversation state before an exploratory detour, so Rewind can restore it later.'

export const CHECKPOINT_TOOL_PROMPT = `Marks the current conversation state as the checkpoint a later rewind restores, before an exploratory detour whose transcript need not stay in context; the goal is echoed back at the rewind. One checkpoint is active at a time, and a run that ends with it still active gets a settle warning. The pair touches the model context only: files, git state and the operator's visible transcript are never changed by it.`
