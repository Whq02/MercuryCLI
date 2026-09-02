// Incremental reverse history search with restore-on-cancel. The
// restore promise is input/cursor/paste-shaped ONLY: cancel does NOT
// restore the composer mode (a walk onto a shell-mode entry leaves that
// mode in place — reproduced as shipped). The reader is closed on
// every exit path so its file handle never leaks.

import { useCallback, useRef } from 'react'
import { loadHistoryCorpus, makeHistoryReaderOver, type HistoryCorpus } from '../history.js'
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

// ── the scan-debounce census (the typeahead timer idiom) ────────────────────
// Each typed character re-scans the history corpus — loaded ONCE per search
// session (FN-020 row 9a: the file used to be re-read and re-parsed per
// keystroke) and matched in memory — and keystrokes inside roughly one frame
// still coalesce to ONE scan — the LAST query wins. Enter and
// the next-match cycle stay immediate: accept/execute read the settled
// match synchronously and never touch the timer; nextMatch FLUSHES a
// pending scan rather than continuing a reader the query outran. Timers
// register here so a prover (and the reset discipline) can count live
// timers — zero after every exit path.
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
  /** The search session's corpus (one read, one parse); null between searches. */
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
    // DOCUMENTED KEEP (L4): AsyncGenerator#return's parameter is typed
    // as the generator's own TReturn, which this reader declares as its
    // yielded row — there is no honest value to pass when the intent is
    // simply "stop iterating", so the closing argument stays widened.
    void readerRef.current?.return?.(undefined as never)
    readerRef.current = null
  }, [])

  const applyMatch = useCallback(
    (entry: HistoryEntry, query: string): void => {
      const mode = getModeFromInput(entry.display)
      onModeChange(mode)
      // The DISPLAY text — sigil included — is applied as input.
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
      void (async () => {
        // FN-020 row 9a: the corpus loads ONCE per search (handleStartSearch)
        // and every scan reads it in memory — no disk read and no parse per
        // keystroke; the reader over it is what a scan continues.
        const corpus = await (corpusRef.current ??= loadHistoryCorpus())
        if (abort.signal.aborted) return
        if (!continueScan || readerRef.current === null) readerRef.current = makeHistoryReaderOver(corpus)
        const reader = readerRef.current
        for (;;) {
          if (abort.signal.aborted) return
          const next = await reader.next()
          if (abort.signal.aborted) return
          if (next.done) {
            // End of history: the failure flag sets, the last match stays.
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
    // Deliberately NOT the mode.
  }, [onInputChange, onCursorChange, setPastedContents])

  const reset = useCallback((): void => {
    disarmHistoryScanTimer(scanDebounceRef.current)
    scanDebounceRef.current = null
    scanAbortRef.current?.abort()
    closeReader()
    corpusRef.current = null
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
    // One read, one parse, per search session; the first scan awaits it.
    corpusRef.current = loadHistoryCorpus()
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
        // Empty query: pending scan dropped, reader closed, match and
        // failure cleared, the ORIGINAL input/cursor/mode/pastes restored
        // — all IMMEDIATE (restore never waits on a frame).
        disarmHistoryScanTimer(scanDebounceRef.current)
        scanDebounceRef.current = null
        scanAbortRef.current?.abort()
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
      // One-frame coalescing: a typing burst pays ONE full-history scan.
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
      // A pending re-scan means the reader does not yet reflect the query:
      // flush it NOW as a fresh scan instead of continuing a stale reader.
      disarmHistoryScanTimer(scanDebounceRef.current)
      scanDebounceRef.current = null
      scan(queryRef.current, false)
      return
    }
    scan(queryRef.current, true)
  }, [scan])

  const accept = useCallback((): void => {
    const match = matchRef.current
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
  }, [onModeChange, onInputChange, setPastedContents, reset])

  const cancel = useCallback((): void => {
    restoreOriginal()
    reset()
  }, [restoreOriginal, reset])

  const execute = useCallback((): void => {
    const query = queryRef.current
    const match = matchRef.current
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
      // Non-empty query with no match submits nothing.
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
  }, [onAcceptHistory, onModeChange, reset])

  // Registrations (contract data): start in Global while NOT searching; the
  // four in-search actions in HistorySearch while searching.
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

  // Backspace on an empty query cancels — conditional, so handled outside
  // the registry; a no-op while not searching. Route standdown: while a
  // non-REPL surface owns the frame the compatibility bridge is inert.
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

// A tiny forced-rerender primitive (the search state lives in refs so the
// scan loop can mutate it mid-flight; renders are explicit).
import { useReducer } from 'react'
function useReducerLike(): [number, () => void] {
  return useReducer((n: number) => n + 1, 0)
}
