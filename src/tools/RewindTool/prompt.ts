import { REWIND_TOOL_NAME } from '../../services/compact/checkpointRewind.js'

export { REWIND_TOOL_NAME }

export const DESCRIPTION =
  'Restore the conversation context to the active checkpoint, carrying back a report of the exploration.'

export const REWIND_TOOL_PROMPT = `Restore the MODEL CONTEXT to the active Checkpoint, abandoning the exploration since it while carrying back your findings.

- \`report\` is required and non-empty: it is the ONE artifact that survives the rewind. Write it like a handoff — findings, decisions, exact file paths, next steps.
- The rewind applies at the END of this turn: the next model call sees the pre-exploration context plus your report; everything between checkpoint and rewind leaves the model context.
- The operator's transcript keeps the exploration visible; your files and git state are NEVER touched by this pair.
- Refuses (typed) when no checkpoint is active or the active one was already rewound.`
