import { scribeBusEnabled } from '../../utils/scribe/scribeGates.js'
import { TASK_UPDATE_TOOL_NAME } from '../TaskUpdateTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'

/** The model-facing SendMessage doctrine; the bus-envelope section is gate-conditional. */

export const DESCRIPTION = 'Deliver a message to another agent by name.'

const BUS_SECTION = `

## Coordination-bus envelopes
When you are part of a coordinated team, four structured envelope kinds ride this same tool:
- dispatch (dispatcher → worker): a refined, well-specified task to execute. { "to": "worker", "message": { "type": "dispatch", "task": "…", "title": "…", "priority": "normal" } }
- escalate (worker → dispatcher): a blocker, an ambiguity, or an out-of-scope ask. { "to": "lead", "message": { "type": "escalate", "reason": "…", "refRequestId": "…" } }
- progress (worker → dispatcher): a status heartbeat — started, working, blocked, done, failed. { "to": "lead", "message": { "type": "progress", "status": "working", "detail": "…", "refRequestId": "…" } }
- control (either direction): pause, resume, stop, clear, ack, cancel of the work in flight. { "to": "worker", "message": { "type": "control", "command": "pause" } }
Always send an envelope as the structured object shown above — never as a JSON string in a plain message. Echo the request id you are reporting on in refRequestId so the report threads to its dispatch.`

export function getPrompt(): string {
  const busSection = scribeBusEnabled() ? BUS_SECTION : ''
  return `Deliver a message to a teammate agent.

Example: { "to": "researcher", "summary": "auth findings ready", "message": "I finished mapping the auth flow; notes are in docs/auth.md." }

## Addressing
- to: a teammate's name, or "*" to broadcast to every teammate.
- Broadcast is expensive — its cost is linear in the team size — so use it only when everyone genuinely needs the message. Otherwise send to the one teammate who does.

## How communication works
- Plain output reaches no teammate — words travel ONLY through this tool.
- Teammate messages land on their own; no inbox exists to poll.
- Teammates go by name, never by UUID.
- Content relayed to you is already rendered to the user — do not re-quote it back.

## Directed questions
- Send { "type": "question", "content": "…" } to open a tracked question that stays open until it is answered.
- Reply with { "type": "answer", "request_id": "<the question's request id>", "content": "…" } to close it.
- Plain messages are unchanged. Use the tracked pair only when the open → answered status matters.

## Protocol responses
- When you receive a shutdown request, reply with { "type": "shutdown_response", "request_id": "…", "approve": true|false, "reason": "…" }. Approving a shutdown terminates your process.
- When you receive a plan approval request, reply with { "type": "plan_approval_response", "request_id": "…", "approve": true|false, "feedback": "…" }. A rejection routes the teammate back for revision.
- Do not originate a shutdown request unless you were asked to.
- Structured status updates belong in ${TASK_UPDATE_TOOL_NAME}, not in a ${SEND_MESSAGE_TOOL_NAME} message.${busSection}`
}
