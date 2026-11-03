import { REWIND_TOOL_NAME } from '../../services/compact/checkpointRewind.js'

export { REWIND_TOOL_NAME }

export const DESCRIPTION =
  'Restore the conversation context to the active checkpoint, carrying back a report of the exploration.'

export const REWIND_TOOL_PROMPT = `Restores the model context to the active checkpoint at the end of this turn: the next model call sees the context from before the exploration plus the report, and everything between the checkpoint and the rewind leaves the model context. The operator's transcript keeps the exploration visible; files and git state are untouched.`
