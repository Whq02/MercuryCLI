
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

type Reader = AsyncGenerator<HistoryEntry>

export const HISTORY_SCAN_DEBOUNCE_MS = 33
const liveScanTimers = new Set<ReturnType<typeof setTimeout>>()
export function historyScanTimerCensus(): number {
  return liveScanTimers.size
}
export function armHistoryScanTimer(
  run: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
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
  clearTimeout(timer)
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
  const queryRef = useRef('')
  const matchRef = useRef<HistoryEntry | undefined>(undefined)
  const failedRef = useRef(false)
  const readerRef = useRef<Reader | null>(null)
  const corpusRef = useRef<Promise<HistoryCorpus> | null>(null)
  const seenRef = useRef(new Set<string>())
  const originalRef = useRef<{
    input: string
    cursor: number
    mode: PromptInputMode
    pastedContents: Record<number, PastedContent>
  } | null>(null)
  const scanAbortRef = useRef<AbortController | null>(null)
  const scanDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const corpusValueRef = useRef<HistoryCorpus | null>(null)
  const scanInFlightRef = useRef(false)
  const scanEpochRef = useRef(0)
  const [, force] = useReducerLike()

  const searchingRef = useRef(isSearching)
  searchingRef.current = isSearching
  const inputRef = useRef(currentInput)
  inputRef.current = currentInput
  const cursorRef = useRef(currentCursorOffset)
  cursorRef.current = currentCursorOffset
  const modeRef = useRef(currentMode)
  modeRef.current = currentMode
  const pastesRef = useRef(currentPastedContents)
  pastesRef.current = currentPastedContents

  const closeReader = useCallback((): void => {
    void readerRef.current?.return?.(undefined as never)
    readerRef.current = null
  }, [])

  const applyMatch = useCallback(
    (entry: HistoryEntry, query: string): void => {
      const mode = getModeFromInput(entry.display)
      onModeChange(mode)
      onInputChange(entry.display)
      setPastedContents(entry.pastedContents)
      const stripped = getValueFromInput(entry.display)
      const inStripped = stripped.lastIndexOf(query)
      const at =
        inStripped !== -1 ? inStripped : Math.max(0, entry.display.lastIndexOf(query))
      onCursorChange(at)
    },
    [onModeChange, onInputChange, setPastedContents, onCursorChange],
  )

  const scan = useCallback(
    (query: string, continueScan: boolean): void => {
      scanAbortRef.current?.abort()
      const abort = new AbortController()
      scanAbortRef.current = abort
      if (!continueScan) {
        closeReader()
        seenRef.current.clear()
      }
      scanInFlightRef.current = true
      const token = ++scanEpochRef.current
      void (async () => {
        try {
          const corpus = await (corpusRef.current ??= loadHistoryCorpus())
          corpusValueRef.current = corpus
          if (abort.signal.aborted) return
          if (!continueScan || readerRef.current === null) readerRef.current = makeHistoryReaderOver(corpus)
          const reader = readerRef.current
          for (;;) {
            if (abort.signal.aborted) return
            const next = await reader.next()
            if (abort.signal.aborted) return
            if (next.done) {
              failedRef.current = true
              force()
              return
            }
            const entry = next.value
            if (!entry.display.includes(query)) continue
            if (seenRef.current.has(entry.display)) continue
            seenRef.current.add(entry.display)
            matchRef.current = entry
            failedRef.current = false
            applyMatch(entry, query)
            force()
            return
          }
        } finally {
          if (token === scanEpochRef.current) scanInFlightRef.current = false
        }
      })()
    },
    [applyMatch, closeReader, force],
  )

  const restoreOriginal = useCallback((): void => {
    const original = originalRef.current
    if (original === null) return
    onInputChange(original.input)
    onCursorChange(original.cursor)
    setPastedContents(original.pastedContents)
  }, [onInputChange, onCursorChange, setPastedContents])

  const reset = useCallback((): void => {
    disarmHistoryScanTimer(scanDebounceRef.current)
    scanDebounceRef.current = null
    scanAbortRef.current?.abort()
    closeReader()
    corpusRef.current = null
    corpusValueRef.current = null
    scanInFlightRef.current = false
    seenRef.current.clear()
    queryRef.current = ''
    matchRef.current = undefined
    failedRef.current = false
    originalRef.current = null
    setIsSearching(false)
    force()
  }, [closeReader, setIsSearching, force])

  const handleStartSearch = useCallback((): void => {
    originalRef.current = {
      input: inputRef.current,
      cursor: cursorRef.current,
      mode: modeRef.current,
      pastedContents: pastesRef.current,
    }
    disarmHistoryScanTimer(scanDebounceRef.current)
    scanDebounceRef.current = null
    closeReader()
    corpusRef.current = loadHistoryCorpus()
    corpusValueRef.current = null
    scanInFlightRef.current = false
    const load = corpusRef.current
    void load.then(
      corpus => {
        if (corpusRef.current === load) corpusValueRef.current = corpus
      },
      () => {},
    )
    seenRef.current.clear()
    queryRef.current = ''
    matchRef.current = undefined
    failedRef.current = false
    setIsSearching(true)
    force()
  }, [closeReader, setIsSearching, force])

  const setHistoryQuery = useCallback(
    (query: string): void => {
      if (!searchingRef.current) return
      queryRef.current = query
      if (query === '') {
        disarmHistoryScanTimer(scanDebounceRef.current)
        scanDebounceRef.current = null
        scanAbortRef.current?.abort()
        scanInFlightRef.current = false
        closeReader()
        seenRef.current.clear()
        matchRef.current = undefined
        failedRef.current = false
        const original = originalRef.current
        if (original !== null) {
          onInputChange(original.input)
          onCursorChange(original.cursor)
          onModeChange(original.mode)
          setPastedContents(original.pastedContents)
        }
        force()
        return
      }
      disarmHistoryScanTimer(scanDebounceRef.current)
      scanDebounceRef.current = armHistoryScanTimer(() => {
        scanDebounceRef.current = null
        scan(queryRef.current, false)
      }, HISTORY_SCAN_DEBOUNCE_MS)
    },
    [scan, closeReader, onInputChange, onCursorChange, onModeChange, setPastedContents, force],
  )

  const nextMatch = useCallback((): void => {
    if (!searchingRef.current || queryRef.current === '') return
    if (scanDebounceRef.current !== null) {
      disarmHistoryScanTimer(scanDebounceRef.current)
      scanDebounceRef.current = null
      scan(queryRef.current, false)
      return
    }
    scan(queryRef.current, true)
  }, [scan])

  const withFixedMatch = useCallback(
    (settle: (match: HistoryEntry | undefined) => void): void => {
      const pending = scanDebounceRef.current !== null
      if (queryRef.current === '' || (!pending && !scanInFlightRef.current)) {
        settle(matchRef.current)
        return
      }
      disarmHistoryScanTimer(scanDebounceRef.current)
      scanDebounceRef.current = null
      scanAbortRef.current?.abort()
      scanInFlightRef.current = false
      if (pending) seenRef.current.clear()
      const corpus = corpusValueRef.current
      const record =
        corpus === null ? undefined : findHistoryMatchSync(corpus, queryRef.current, seenRef.current)
      if (record === undefined) {
        settle(undefined)
        return
      }
      resolveFixedMatch(record, settle)
    },
    [],
  )

  const accept = useCallback((): void => {
    withFixedMatch(match => {
      if (match !== undefined) {
        const mode = getModeFromInput(match.display)
        onModeChange(mode)
        onInputChange(getValueFromInput(match.display))
        setPastedContents(match.pastedContents)
      } else {
        const original = originalRef.current
        if (original !== null) setPastedContents(original.pastedContents)
      }
      reset()
    })
  }, [withFixedMatch, onModeChange, onInputChange, setPastedContents, reset])

  const cancel = useCallback((): void => {
    restoreOriginal()
    reset()
  }, [restoreOriginal, reset])

  const execute = useCallback((): void => {
    withFixedMatch(match => {
      const query = queryRef.current
      if (query === '') {
        const original = originalRef.current
        if (original !== null) {
          onAcceptHistory({
            display: original.input,
            pastedContents: original.pastedContents,
          })
        }
        reset()
        return
      }
      if (match === undefined) {
        reset()
        return
      }
      const mode = getModeFromInput(match.display)
      onModeChange(mode)
      onAcceptHistory({
        display: getValueFromInput(match.display),
        pastedContents: match.pastedContents,
      })
      reset()
    })
  }, [withFixedMatch, onAcceptHistory, onModeChange, reset])

  useKeybinding(
    'history:search',
    () => {
      handleStartSearch()
    },
    { context: 'Global', isActive: !isSearching },
  )
  useKeybindings(
    {
      'historySearch:next': () => {
        nextMatch()
      },
      'historySearch:accept': () => {
        accept()
      },
      'historySearch:cancel': () => {
        cancel()
      },
      'historySearch:execute': () => {
        execute()
      },
    },
    { context: 'HistorySearch', isActive: isSearching },
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!searchingRef.current) return
      if (currentSurfaceRoute().kind !== 'repl') return
      if (e.key === 'backspace' && queryRef.current === '') {
        e.stopImmediatePropagation()
        cancel()
      }
    },
    [cancel],
  )

  return {
    historyQuery: queryRef.current,
    setHistoryQuery,
    historyMatch: matchRef.current,
    historyFailedMatch: failedRef.current,
    handleKeyDown,
    handleStartSearch,
  }
}

import { useReducer } from 'react'
function useReducerLike(): [number, () => void] {
  return useReducer((n: number) => n + 1, 0)
}
