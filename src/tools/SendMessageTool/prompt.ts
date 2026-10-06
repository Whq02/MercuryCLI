import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'

export const DESCRIPTION = 'Deliver a message to a crewmate of this session by its id or name.'

export function getPrompt(offered: ReadonlySet<string> = new Set([TASK_UPDATE_TOOL_NAME])): string {
  const statusLine = offered.has(TASK_UPDATE_TOOL_NAME) ? `\n- Structured status updates belong in ${TASK_UPDATE_TOOL_NAME}, not in a ${SEND_MESSAGE_TOOL_NAME} message.` : ''
  return `Deliver a message to a crewmate of this session.

Example: { "to": "researcher", "message": "I finished mapping the auth flow; notes are in docs/auth.md." }

## Addressing
- to: the id a crewmate's launch receipt names, or the name its launch gave it — both reach the same agent, running or finished (a name two launches carried reaches the newest).

## How communication works
- Plain output reaches no crewmate — words travel ONLY through this tool.
- A running crewmate reads the message at its next tool boundary, else at the end of its turn; a completed, stopped or failed one is resumed from its transcript with your message as its next turn.
- A background crewmate reaches the agent that launched it at "main". A message lands the way a completion does: at the receiver's next tool boundary or turn end; a receiver between turns starts a turn for it.
- Content relayed to you is already rendered to the user — do not re-quote it back.${statusLine}`
}
