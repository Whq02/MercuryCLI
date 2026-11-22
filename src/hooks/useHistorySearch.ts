import { featureReached } from '../substrate/featureReached.js'

import { useCallback, useRef } from 'react'
import { loadHistoryCorpus, makeHistoryReaderOver, type HistoryCorpus, type HistoryRecord } from '../history.js'
import type { HistoryEntry, PastedContent } from '../utils/config.js'
import {
  getModeFromInput,
  getValueFromInput,
} from '../components/PromptInput/inputModes.js'
import type { PromptInputMode } from '../types/textInputTypes.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { currentSurfaceRoute } from '../context/surfaceRoute.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { scanOf, type Reader } from './historySearch/scan.js'

export const HISTORY_SCAN_DEBOUNCE_MS = 33
const liveScanTimers = new Set<ReturnType<typeof setTimeout>>()
export function historyScanTimerCensus(): number {
  return liveScanTimers.size
}
export function armHistoryScanTimer(
  run: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timer = startTimeout(() => {
    liveScanTimers.delete(timer)
    run()
  }, delayMs)
  liveScanTimers.add(timer)
  return timer
}
export function disarmHistoryScanTimer(
  timer: ReturnType<typeof setTimeout> | null,
): void {
  if (timer === null) return
  stopTimeout(timer)
  liveScanTimers.delete(timer)
}

export function findHistoryMatchSync(
  corpus: HistoryCorpus,
  query: string,
  seen: ReadonlySet<string>,
): HistoryRecord | undefined {
  for (const record of corpus) {
    if (!record.display.includes(query)) continue
    if (seen.has(record.display)) continue
    return record
  }
  return undefined
}

export function resolveFixedMatch(
  record: HistoryRecord,
  settle: (entry: HistoryEntry | undefined) => void,
): void {
  if (Object.keys(record.pastedContents ?? {}).length === 0) {
    settle({ display: record.display, pastedContents: {} })
    return
  }
  void (async () => {
    const next = await makeHistoryReaderOver([record]).next()
    return next.done ? undefined : next.value
  })().then(settle, () => settle(undefined))
}

export function useHistorySearch(
  onAcceptHistory: (entry: HistoryEntry) => void,
  currentInput: string,
  onInputChange: (input: string) => void,
  onCursorChange: (cursorOffset: number) => void,
  currentCursorOffset: number,
  onModeChange: (mode: PromptInputMode) => void,
  currentMode: PromptInputMode,
  isSearching: boolean,
  setIsSearching: (isSearching: boolean) => void,
  setPastedContents: (pastedContents: Record<number, PastedContent>) => void,
  currentPastedContents: Record<number, PastedContent>,
): {
  historyQuery: string
  setHistoryQuery: (query: string) => void
  historyMatch: HistoryEntry | undefined
  historyFailedMatch: boolean
  handleKeyDown: (e: KeyboardEvent) => void
  handleStartSearch: () => void
} {
  return notBuilt('src/hooks/useHistorySearch.ts:67')
}

import { useReducer } from 'react'
import { passedOver } from '../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'
function useReducerLike(): [number, () => void] {
  return useReducer((n: number) => n + 1, 0)
}
