
import { useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
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
