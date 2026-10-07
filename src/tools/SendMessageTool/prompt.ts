import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'

export const DESCRIPTION = 'Deliver a message to a running crewmate of this session by its id or name.'

export function getPrompt(offered: ReadonlySet<string> = new Set([TASK_UPDATE_TOOL_NAME])): string {
  const statusLine = offered.has(TASK_UPDATE_TOOL_NAME) ? `\n- Structured status updates belong in ${TASK_UPDATE_TOOL_NAME}, not in a ${SEND_MESSAGE_TOOL_NAME} message.` : ''
  return `Deliver a message to a running crewmate of this session. It never starts work: a crewmate that has finished is refused, and ResumeAgent gives it the message as a new turn.

Example: { "to": "researcher", "message": "The auth notes moved to docs/auth-v2.md; read that one." }

## Addressing
- to: the id a crewmate's launch receipt names, or the name its launch gave it — both reach the same agent (a name two launches carried reaches the newest).
- A background crewmate reaches the agent that launched it at "main".

## How communication works
- Plain output reaches no crewmate — words travel ONLY through this tool and ResumeAgent.
- A running crewmate reads the message at its next tool boundary, else at the end of its turn. The main agent reads it the same way; between turns it starts a turn for it.
- Content relayed to you is already rendered to the user — do not re-quote it back.${statusLine}`
}
