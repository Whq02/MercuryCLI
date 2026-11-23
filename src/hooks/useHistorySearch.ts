import { featureReached } from '../substrate/featureReached.js'

import { useCallback, useReducer, useRef } from 'react'
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
import { passedOver } from '../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { useClaim } from './effects.js'
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

type OriginalDraft = {
  input: string
  cursorOffset: number
  mode: PromptInputMode
  pastedContents: Record<number, PastedContent>
}

function cursorForPreview(display: string, query: string): number {
  const stripped = getValueFromInput(display)
  const idx = stripped.lastIndexOf(query)
  return idx >= 0 ? idx : Math.max(0, display.lastIndexOf(query))
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
  const [, force] = useReducer((n: number) => n + 1, 0)
  const queryRef = useRef('')
  const matchRef = useRef<HistoryEntry | undefined>(undefined)
  const failedRef = useRef(false)
  const seenRef = useRef<Set<string>>(new Set())
  const readerRef = useRef<Reader | null>(null)
  const corpusRef = useRef<Promise<HistoryCorpus> | null>(null)
  const corpusValueRef = useRef<HistoryCorpus | null>(null)
  const scanAbortRef = useRef<AbortController | null>(null)
  const scanInFlightRef = useRef(false)
  const scanEpochRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originalRef = useRef<OriginalDraft | null>(null)

  const latestRef = useRef({
    onAcceptHistory,
    onInputChange,
    onCursorChange,
    onModeChange,
    setIsSearching,
    setPastedContents,
    isSearching,
    currentInput,
    currentPastedContents,
  })
  latestRef.current = {
    onAcceptHistory,
    onInputChange,
    onCursorChange,
    onModeChange,
    setIsSearching,
    setPastedContents,
    isSearching,
    currentInput,
    currentPastedContents,
  }

  const closeReader = useCallback(() => {
    const reader = readerRef.current
    readerRef.current = null
    if (reader !== null) void reader.return(undefined).catch(passedOver)
  }, [])

  const cancelDebounce = useCallback(() => {
    disarmHistoryScanTimer(debounceTimerRef.current)
    debounceTimerRef.current = null
  }, [])

  useClaim(() => () => {
    cancelDebounce()
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    closeReader()
  }, [cancelDebounce, closeReader])

  const applyMatch = useCallback((entry: HistoryEntry, query: string) => {
    const latest = latestRef.current
    latest.onModeChange(getModeFromInput(entry.display))
    latest.onInputChange(entry.display)
    latest.setPastedContents(entry.pastedContents ?? {})
    latest.onCursorChange(cursorForPreview(entry.display, query))
  }, [])

  const runScan = useCallback((query: string, continueScan: boolean) => {
    scanOf(
      {
        scanAbortRef,
        closeReader,
        seenRef,
        scanInFlightRef,
        scanEpochRef,
        corpusRef,
        corpusValueRef,
        readerRef,
        failedRef,
        force,
        matchRef,
        applyMatch,
      },
      query,
      continueScan,
    )
  }, [closeReader, applyMatch])

  const resetSearch = useCallback(() => {
    cancelDebounce()
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    closeReader()
    corpusRef.current = null
    corpusValueRef.current = null
    seenRef.current.clear()
    queryRef.current = ''
    matchRef.current = undefined
    failedRef.current = false
    originalRef.current = null
    latestRef.current.setIsSearching(false)
    force()
  }, [cancelDebounce, closeReader])

  const takeFixedMatch = useCallback(():
    | { kind: 'ready'; match: HistoryEntry | undefined }
    | { kind: 'record'; record: HistoryRecord } => {
    const query = queryRef.current
    const debouncePending = debounceTimerRef.current !== null
    if (query === '' || (!debouncePending && !scanInFlightRef.current)) {
      return { kind: 'ready', match: matchRef.current }
    }
    cancelDebounce()
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    const corpus = corpusValueRef.current
    if (corpus === null) return { kind: 'ready', match: undefined }
    const seen: ReadonlySet<string> = debouncePending ? new Set<string>() : seenRef.current
    const record = findHistoryMatchSync(corpus, query, seen)
    return record === undefined ? { kind: 'ready', match: undefined } : { kind: 'record', record }
  }, [cancelDebounce])

  const handleStartSearch = useCallback(() => {
    originalRef.current = {
      input: currentInput,
      cursorOffset: currentCursorOffset,
      mode: currentMode,
      pastedContents: currentPastedContents,
    }
    cancelDebounce()
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    closeReader()
    const corpusPromise = loadHistoryCorpus()
    corpusRef.current = corpusPromise
    corpusValueRef.current = null
    void corpusPromise.then(corpus => {
      if (corpusRef.current === corpusPromise) corpusValueRef.current = corpus
    }, passedOver)
    seenRef.current.clear()
    queryRef.current = ''
    matchRef.current = undefined
    failedRef.current = false
    featureReached('screen', 'HistorySearchInput')
    latestRef.current.setIsSearching(true)
    force()
  }, [currentInput, currentCursorOffset, currentMode, currentPastedContents, cancelDebounce, closeReader])

  const setHistoryQuery = useCallback((query: string) => {
    queryRef.current = query
    if (!latestRef.current.isSearching) {
      force()
      return
    }
    if (query === '') {
      cancelDebounce()
      scanAbortRef.current?.abort()
      scanAbortRef.current = null
      closeReader()
      matchRef.current = undefined
      seenRef.current.clear()
      failedRef.current = false
      const orig = originalRef.current
      if (orig !== null) {
        const latest = latestRef.current
        latest.onInputChange(orig.input)
        latest.onCursorChange(orig.cursorOffset)
        latest.onModeChange(orig.mode)
        latest.setPastedContents(orig.pastedContents)
      }
      force()
      return
    }
    cancelDebounce()
    debounceTimerRef.current = armHistoryScanTimer(() => {
      debounceTimerRef.current = null
      runScan(queryRef.current, false)
    }, HISTORY_SCAN_DEBOUNCE_MS)
    force()
  }, [cancelDebounce, closeReader, runScan])

  const handleNext = useCallback(() => {
    if (!latestRef.current.isSearching) return
    const query = queryRef.current
    if (query === '') return
    if (debounceTimerRef.current !== null) {
      cancelDebounce()
      runScan(query, false)
      return
    }
    runScan(query, true)
  }, [cancelDebounce, runScan])

  const handleAccept = useCallback(() => {
    const orig = originalRef.current
    const settled = takeFixedMatch()
    resetSearch()
    const finish = (match: HistoryEntry | undefined): void => {
      const latest = latestRef.current
      if (match !== undefined) {
        latest.onModeChange(getModeFromInput(match.display))
        latest.onInputChange(getValueFromInput(match.display))
        latest.setPastedContents(match.pastedContents ?? {})
      } else if (orig !== null) {
        latest.setPastedContents(orig.pastedContents)
      }
    }
    if (settled.kind === 'ready') finish(settled.match)
    else resolveFixedMatch(settled.record, finish)
  }, [takeFixedMatch, resetSearch])

  const handleCancel = useCallback(() => {
    const orig = originalRef.current
    if (orig !== null) {
      const latest = latestRef.current
      latest.onInputChange(orig.input)
      latest.onCursorChange(orig.cursorOffset)
      latest.setPastedContents(orig.pastedContents)
    }
    resetSearch()
  }, [resetSearch])

  const handleExecute = useCallback(() => {
    const query = queryRef.current
    const orig = originalRef.current
    if (query === '') {
      resetSearch()
      const latest = latestRef.current
      latest.onAcceptHistory({
        display: orig ? orig.input : latest.currentInput,
        pastedContents: orig ? orig.pastedContents : latest.currentPastedContents,
      })
      return
    }
    const settled = takeFixedMatch()
    resetSearch()
    const finish = (match: HistoryEntry | undefined): void => {
      if (match === undefined) return
      const latest = latestRef.current
      latest.onModeChange(getModeFromInput(match.display))
      latest.onAcceptHistory({
        display: getValueFromInput(match.display),
        pastedContents: match.pastedContents ?? {},
      })
    }
    if (settled.kind === 'ready') finish(settled.match)
    else resolveFixedMatch(settled.record, finish)
  }, [takeFixedMatch, resetSearch])

  useKeybinding('history:search', handleStartSearch, { context: 'Global', isActive: !isSearching })
  useKeybindings(
    {
      'historySearch:next': handleNext,
      'historySearch:accept': handleAccept,
      'historySearch:cancel': handleCancel,
      'historySearch:execute': handleExecute,
    },
    { context: 'HistorySearch', isActive: isSearching },
  )

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (
      latestRef.current.isSearching &&
      queryRef.current === '' &&
      e.key === 'backspace' &&
      currentSurfaceRoute().kind === 'repl'
    ) {
      e.preventDefault()
      e.stopImmediatePropagation()
      handleCancel()
    }
  }, [handleCancel])

  return {
    historyQuery: queryRef.current,
    setHistoryQuery,
    historyMatch: matchRef.current,
    historyFailedMatch: failedRef.current,
    handleKeyDown,
    handleStartSearch,
  }
}
