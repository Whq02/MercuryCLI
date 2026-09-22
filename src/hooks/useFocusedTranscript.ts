
import { useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../services/engine-connector/seatLive.js'
import type { Message } from '../types/message.js'

const subscribeFocusedRecords = subscribeThroughFocused((connector, listener) =>
  connector.subscribeRecords(listener),
)

function getFocusedRecords(): readonly Message[] {
  return getFocusedSessionConnector().records()
}

export function useFocusedTranscript(): Message[] {
  return useSyncExternalStore(
    subscribeFocusedRecords,
    getFocusedRecords,
    getFocusedRecords,
  ) as Message[]
}

function getFocusedTailAnchor(): number {
  const connector = getFocusedSessionConnector()
  return hasSeatLive(connector) && typeof connector.tailAnchor === 'function' ? connector.tailAnchor() : Number.MAX_SAFE_INTEGER
}

export function useFocusedTailAnchor(): number {
  return useSyncExternalStore(subscribeFocusedRecords, getFocusedTailAnchor, getFocusedTailAnchor)
}
