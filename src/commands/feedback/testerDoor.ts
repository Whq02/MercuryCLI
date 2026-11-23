import { conversationIdHere, getFocusedSessionConnector, hasFocusedSession } from '../../engine/connector/focusedConnector.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { buildAwayRecap } from '../../screen/cockpit/awaySummary.js'
import { isDenialResultText } from '../../engine/message-shapes/rejectionText.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const TESTER_DOOR_URL = 'https://mercury-cli.ai/report'
export const TESTER_DOOR_LINE = `Something broke? ${TESTER_DOOR_URL}`
const shown = new Set<string>()

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: unknown; text?: unknown }>).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

function toolErroredOutsideADenial(messages: readonly Message[]): boolean {
  for (const m of messages) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    for (const block of m.message.content) {
      if (block.type !== 'tool_result' || block.is_error !== true) continue
      if (!isDenialResultText(resultText(block.content))) return true
    }
  }
  return false
}

export function sessionSawFailure(messages: readonly Message[]): boolean {
  const recap = buildAwayRecap(messages as Message[], Date.now())
  return recap !== null && (recap.endedOnError || toolErroredOutsideADenial(messages))
}

function focusedSessionSawFailure(): boolean {
  try {
    return hasFocusedSession() && sessionSawFailure(getFocusedSessionConnector().records())
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function takeTesterDoor(sessionId: string = conversationIdHere(), sawFailure: boolean = focusedSessionSawFailure()): string | null {
  if (!sawFailure) return null
  if (shown.has(sessionId)) return null
  shown.add(sessionId)
  return TESTER_DOOR_LINE
}

export function farewellWithTesterDoor(message: string): string {
  const line = takeTesterDoor()
  return line === null ? message : `${message}\n${line}`
}
