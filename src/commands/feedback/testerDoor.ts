import { conversationIdHere, getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import type { Message } from '../../types/message.js'
import { buildAwayRecap } from '../../utils/cockpit/awaySummary.js'

const TESTER_DOOR_URL = 'https://mercury-cli.ai/report'
export const TESTER_DOOR_LINE = `Something broke? ${TESTER_DOOR_URL}`
const shown = new Set<string>()

export function sessionSawFailure(messages: readonly Message[]): boolean {
  const recap = buildAwayRecap(messages as Message[], Date.now())
  return recap !== null && (recap.endedOnError || recap.toolFailures > 0)
}

function focusedSessionSawFailure(): boolean {
  try {
    return hasFocusedSession() && sessionSawFailure(getFocusedSessionConnector().records())
  } catch {
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
