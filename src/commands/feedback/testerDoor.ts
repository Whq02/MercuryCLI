import { conversationIdHere } from '../../services/engine-connector/focusedConnector.js'

export const TESTER_DOOR_URL = 'https://mercury-cli.ai/report'
export const TESTER_DOOR_LINE = `Something broke? ${TESTER_DOOR_URL}`
const shown = new Set<string>()

export function takeTesterDoor(sessionId: string = conversationIdHere()): string | null {
  if (shown.has(sessionId)) return null
  shown.add(sessionId)
  return TESTER_DOOR_LINE
}

export function farewellWithTesterDoor(message: string): string {
  const line = takeTesterDoor()
  return line === null ? message : `${message}\n${line}`
}
