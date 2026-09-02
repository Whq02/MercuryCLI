import { CHECKPOINT_TOOL_NAME } from '../../services/compact/checkpointRewind.js'

export { CHECKPOINT_TOOL_NAME }

export const DESCRIPTION =
  'Mark the current conversation state before an exploratory detour, so Rewind can restore it later.'

export const CHECKPOINT_TOOL_PROMPT = `Mark the CURRENT conversation state as a checkpoint before starting an exploratory detour (a risky refactor investigation, a speculative design probe, a large read-heavy dig) whose transcript you may not want to keep in context afterwards.

- State the goal of the exploration in \`goal\` — it is echoed back on Rewind.
- ONE checkpoint may be active at a time; a second call refuses (typed) until you Rewind.
- While a checkpoint is active, ending the run without Rewind gets a settle warning: either Rewind with a report, or say explicitly why the exploration should stand.
- Rewind restores the MODEL CONTEXT only: your files, git state, and the operator's visible transcript are NEVER touched by this pair. (The operator's own /rewind command is a different device and can restore code.)
- After Rewind, everything between the checkpoint and the rewind disappears from your context; your \`report\` is retained as the one carried-back artifact. Write it like a handoff: findings, decisions, exact paths.`
