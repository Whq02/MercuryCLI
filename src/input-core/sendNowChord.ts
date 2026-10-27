export const SEND_NOW_WINDOW_MS = 2_000
export const SEND_NOW_HINT = 'ctrl+s s sends now'

type SendNowFactsV1 = {
  inFlight: boolean
  toolsInFlight: number
  queuedSends: number
}

export function sendNowLive(facts: SendNowFactsV1): boolean {
  return facts.inFlight && facts.toolsInFlight > 0 && facts.queuedSends > 0
}

let armedAtMs: number | null = null

export function pressSendNow(live: boolean, nowMs: number = Date.now()): boolean {
  if (!live) {
    armedAtMs = null
    return false
  }
  if (armedAtMs !== null && nowMs - armedAtMs <= SEND_NOW_WINDOW_MS) {
    armedAtMs = null
    return true
  }
  armedAtMs = nowMs
  return false
}

export function disarmSendNow(): void {
  armedAtMs = null
}
