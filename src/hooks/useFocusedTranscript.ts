// The transcript AS RENDERED: the focused chat's records through its engine
// connector. The in-process engine answers with its own transcript lane; a
// daemon-hosted session answers with its own file's records (echo rows
// included). A hop re-points the slot and the subscription re-attaches —
// the chat, the composer's history reads and the frame all repaint the new
// session's records on the same beat.

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
