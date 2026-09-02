// Incremental reverse history search with restore-on-cancel. The
// restore promise is input/cursor/paste-shaped ONLY: cancel does NOT
// restore the composer mode (a walk onto a shell-mode entry leaves that
// mode in place — reproduced as shipped). The reader is closed on
// every exit path so its file handle never leaks.

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

// ── the scan-debounce census (the typeahead timer idiom) ────────────────────
// Each typed character re-scans the history corpus — loaded ONCE per search
// session (FN-020 row 9a: the file used to be re-read and re-parsed per
// keystroke) and matched in memory — and keystrokes inside roughly one frame
// still coalesce to ONE scan — the LAST query wins. Enter stays immediate:
// accept/execute fix the match identity synchronously — the settled match,
// or, while the query's scan is still pending or in flight, a synchronous
// walk over the loaded corpus (findHistoryMatchSync below); nextMatch
// FLUSHES a pending scan rather than continuing a reader the query outran.
// Timers register here so a prover (and the reset discipline) can count
// live timers — zero after every exit path.
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

// ── the fast-Enter match: the identity is fixed synchronously ───────────────
// The settled match reflects the query only once the query's scan has
// LANDED. Two states say it has not yet: a debounce timer still pending
// (the keystroke's scan has not started) and a scan in flight — the scan
// awaits the corpus, then a reader that resolves pastes and may touch the
// disk, so that window is wider than the timer. Enter used to read straight
// through both: a keystroke inside the window followed by a fast Enter
// EXECUTED the previous query's match, and reset threw the fresh scan away.
// Now accept/execute fix the identity synchronously over the already-loaded
// corpus — the first not-yet-seen record whose display includes the query,
// in the reader's own order — and only a paste-bearing record's resolution
// is awaited after that, through the same reader the scan uses (the one
// owner of paste resolution). Both exported for the prover.
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

/** Resolve a FIXED match into the entry Enter acts on: a record without
 *  pastes resolves in place, synchronously; a paste-bearing one resolves
 *  through the corpus reader, asynchronously — after the identity is fixed,
 *  never before. A resolution that fails settles nothing (Enter then acts
 *  on no match) rather than a degraded entry. */
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
  /** The loaded corpus itself, for the fast-Enter walk; null until loaded. */
  const corpusValueRef = useRef<HistoryCorpus | null>(null)
  /** A scan started and has not landed. Its landing is epoch-guarded: a
   *  superseded scan cannot clear the flag from under a newer one. */
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
      scanInFlightRef.current = true
      const token = ++scanEpochRef.current
      void (async () => {
        try {
          // FN-020 row 9a: the corpus loads ONCE per search (handleStartSearch)
          // and every scan reads it in memory — no disk read and no parse per
          // keystroke; the reader over it is what a scan continues.
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
        } finally {
          // The landing edge on every road out (a match, the end of history,
          // superseded, thrown); a newer scan owns the flag past its start.
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
    // Deliberately NOT the mode.
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
    // One read, one parse, per search session; the first scan awaits it,
    // and the loaded value is kept beside the promise for the fast-Enter
    // walk (a load failure surfaces through the scan's own await).
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
        // Empty query: pending scan dropped, reader closed, match and
        // failure cleared, the ORIGINAL input/cursor/mode/pastes restored
        // — all IMMEDIATE (restore never waits on a frame).
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

  /** The match Enter acts on. The settled match is the query's own only
   *  once the query's scan has landed; while a debounce timer is pending
   *  or a scan is in flight it is the PREVIOUS query's, so the identity is
   *  fixed synchronously instead: the timer is disarmed, the scan aborted,
   *  and the loaded corpus walked — with a fresh scan's semantics when the
   *  timer was pending (the previous query's seen set is dropped) and a
   *  continuing scan's when it was in flight (the seen set stands, so the
   *  next not-yet-seen match is the one). A corpus that has not loaded yet
   *  fixes nothing: Enter then acts on no match, never on a stale one.
   *  Only a paste-bearing record's resolution is awaited, after the fix. */
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
    })
  }, [withFixedMatch, onAcceptHistory, onModeChange, reset])

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
