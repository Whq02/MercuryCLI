import { busEnvelopesEnabled } from '../../utils/swarm/busEnvelopes.js'
import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'


export const DESCRIPTION = 'Deliver a message to another agent by name.'

const BUS_SECTION = `

## Coordination-bus envelopes
When you are part of a coordinated crew, four structured envelope kinds ride this same tool:
- dispatch (dispatcher → worker): a refined, well-specified task to execute. { "to": "worker", "message": { "type": "dispatch", "task": "…", "title": "…", "priority": "normal" } }
- escalate (worker → dispatcher): a blocker, an ambiguity, or an out-of-scope ask. { "to": "lead", "message": { "type": "escalate", "reason": "…", "refRequestId": "…" } }
- progress (worker → dispatcher): a status heartbeat — started, working, blocked, done, failed. { "to": "lead", "message": { "type": "progress", "status": "working", "detail": "…", "refRequestId": "…" } }
- control (either direction): pause, resume, stop, clear, ack, cancel of the work in flight. { "to": "worker", "message": { "type": "control", "command": "pause" } }
Always send an envelope as the structured object shown above — never as a JSON string in a plain message. Echo the request id you are reporting on in refRequestId so the report threads to its dispatch.`

export function getPrompt(offered: ReadonlySet<string> = new Set([TASK_UPDATE_TOOL_NAME])): string {
  const busSection = busEnvelopesEnabled() ? BUS_SECTION : ''
  const statusLine = offered.has(TASK_UPDATE_TOOL_NAME) ? `\n- Structured status updates belong in ${TASK_UPDATE_TOOL_NAME}, not in a ${SEND_MESSAGE_TOOL_NAME} message.` : ''
  return `Deliver a message to a crewmate agent.

Example: { "to": "researcher", "summary": "auth findings ready", "message": "I finished mapping the auth flow; notes are in docs/auth.md." }

## Addressing
- to: a crewmate's name, or "*" to broadcast to every crewmate.
- summary: optional, a 5-10 word preview shown beside the sender's name (the first line of the message when omitted).
- Broadcast is expensive — its cost is linear in the crew size — so use it only when everyone genuinely needs the message. Otherwise send to the one crewmate who does.

## How communication works
- Plain output reaches no crewmate — words travel ONLY through this tool.
- Crewmate messages land on their own; no inbox exists to poll.
- Crewmates go by name, never by UUID. A sub-agent launched from this session is addressed by the id its launch receipt names, or by the name the launch gave it — both reach the same agent, running or finished (a name two launches carried reaches the newest); a completed, stopped or failed one is resumed from its transcript with your message.
- A crewmate that was stopped from the crew view or has finished is reached by its name the same way: it is resumed from its transcript with your message as its next turn, under a new row with the same name; a seat that failed keeps its refusal with the cause.
- A background sub-agent reaches the agent that launched it at "main". A message lands the way a completion does: at the receiver's next tool boundary or turn end; a receiver between turns starts a turn for it.
- Content relayed to you is already rendered to the user — do not re-quote it back.

## Directed questions
- Send { "type": "question", "content": "…" } to open a tracked question that stays open until it is answered.
- Reply with { "type": "answer", "request_id": "<the question's request id>", "content": "…" } to close it.
- Plain messages are unchanged. Use the tracked pair only when the open → answered status matters.

## Protocol responses
- When you receive a shutdown request, reply with { "type": "shutdown_response", "request_id": "…", "approve": true|false, "reason": "…" }. Approving a shutdown terminates your process.
- When you receive a plan approval request, reply with { "type": "plan_approval_response", "request_id": "…", "approve": true|false, "feedback": "…" }. A rejection routes the crewmate back for revision.
- Do not originate a shutdown request unless you were asked to.${statusLine}${busSection}`
}
