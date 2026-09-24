import { useSyncExternalStore } from 'react'
import { getFocusedSessionConnector, subscribeThroughFocused } from './focusedConnector.js'
import { hasSeatLive } from './seatLive.js'
import { mainShellRunsNow, subscribeShellRuns } from '../../tools/BashTool/backgroundRequest.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { Message } from '../../types/message.js'

export const BACKGROUND_HINT_AFTER_MS = 100_000
export const BACKGROUND_HINT_ACTION = 'chat:backgroundShell'
export const BACKGROUND_HINT_WORDS = 'run in background'
export const BACKGROUND_MOVED_WORDS = 'Running in the background — see /tasks'

export type ToolUseEntryV1 = { id: string; name: string }

export function firstRunningShellId(entries: readonly ToolUseEntryV1[], inProgress: ReadonlySet<string>): string | null {
  for (const entry of entries) {
    if (entry.name === BASH_TOOL_NAME && inProgress.has(entry.id)) return entry.id
  }
  return null
}

export function movedToBackgroundByOperator(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { backgroundedByUser?: unknown }).backgroundedByUser === true
}

export function shellToolRunning(records: readonly Message[], inProgress: ReadonlySet<string>): boolean {
  if (inProgress.size === 0) return false
  for (let i = records.length - 1; i >= 0; i--) {
    const row = records[i] as { type?: string; message?: { content?: unknown } }
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    for (const block of row.message.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && inProgress.has(block.id) && block.name === BASH_TOOL_NAME) return true
    }
  }
  return false
}

const subscribeFocusedShell = subscribeThroughFocused((connector, listener) => {
  const records = connector.subscribeRecords(listener)
  const live = hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {}
  return () => {
    records()
    live()
  }
})

export function focusedShellRunning(): boolean {
  if (mainShellRunsNow() > 0) return true
  const connector = getFocusedSessionConnector()
  if (!hasSeatLive(connector)) return false
  const live = connector.live()
  if (!live.inFlight) return false
  return shellToolRunning(connector.records(), live.inProgressToolUseIDs)
}

export function focusedShellToolRunning(id: string): boolean {
  const connector = getFocusedSessionConnector()
  if (!hasSeatLive(connector)) return false
  const live = connector.live()
  return live.inFlight && live.inProgressToolUseIDs.has(id)
}

function subscribeShellRunning(listener: () => void): () => void {
  const focused = subscribeFocusedShell(listener)
  const local = subscribeShellRuns(listener)
  return () => {
    focused()
    local()
  }
}

export function useFocusedShellRunning(): boolean {
  return useSyncExternalStore(subscribeShellRunning, focusedShellRunning, focusedShellRunning)
}

export function useFocusedShellToolRunning(id: string): boolean {
  const read = (): boolean => focusedShellToolRunning(id)
  return useSyncExternalStore(subscribeShellRunning, read, read)
}
