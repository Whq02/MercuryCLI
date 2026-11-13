import { REWIND_TOOL_NAME } from '../../services/compact/checkpointRewind.js'

export { REWIND_TOOL_NAME }

export const DESCRIPTION =
  'Restore the conversation context to the active checkpoint, carrying back a report of the exploration.'

export const REWIND_TOOL_PROMPT = `Restores model context to the active checkpoint at turn end: the next call sees pre-checkpoint context plus report, dropping intermediate messages from model context while keeping them in the operator's transcript (files and git untouched).`
