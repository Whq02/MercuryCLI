import { useSyncExternalStore } from 'react'
import { sendNowLive } from '../../screen/composer/input-core/sendNowChord.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from './focusedConnector.js'
import { hasSeatLive } from './seatLive.js'
import type { CrewmateControlReceiptV1 } from './types.js'

const subscribeFocusedSendNow = subscribeThroughFocused((connector, listener) => {
  const records = connector.subscribeRecords(listener)
  const live = hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {}
  return () => {
    records()
    live()
  }
})

export function focusedSendNowLive(): boolean {
  const connector = getFocusedSessionConnector()
  if (!hasSeatLive(connector)) return false
  const live = connector.live()
  return sendNowLive({ inFlight: live.inFlight, toolsInFlight: live.inProgressToolUseIDs.size, queuedSends: connector.queuedSendCount() })
}

export function useFocusedSendNowLive(): boolean {
  return useSyncExternalStore(subscribeFocusedSendNow, focusedSendNowLive, focusedSendNowLive)
}

export function sendFocusedWordsNow(): Promise<CrewmateControlReceiptV1> {
  return getFocusedSessionConnector().sendNow()
}
