// Up/Down prompt-history recall. The index is a REF, captured and
// incremented synchronously — rapid keypresses must never read stale
// values. Entries load in chunks of 10 with process-level batching so a
// held key costs one disk read; the walk's mode filter is fixed at the
// first press. The one-per-session search hint renders the RESOLVED
// reverse-search chord and rides the shared footer transient timeout.

import React, { useCallback, useRef } from 'react'
import { Text } from '../ink.js'
import { getHistory } from '../history.js'
import type { HistoryEntry, PastedContent } from '../utils/config.js'
import { useNotifications } from '../context/notifications.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { FOOTER_TEMPORARY_STATUS_TIMEOUT } from '../components/PromptInput/Notifications.js'
import { ConfigurableShortcutHint } from '../components/ConfigurableShortcutHint.js'
import {
  getModeFromInput,
  getValueFromInput,
} from '../components/PromptInput/inputModes.js'
import type { PromptInputMode } from '../types/textInputTypes.js'
import { logForDebugging } from '../utils/debug.js'

export type HistoryMode = PromptInputMode

const CHUNK = 10
const SEARCH_HINT_KEY = 'history-search-hint'

// Process-level load batching: filtered and unfiltered caches never mix.
let loadedEntries: HistoryEntry[] = []
let loadedFilter: HistoryMode | undefined
let loadExhausted = false
let pendingLoad: {
  filter: HistoryMode | undefined
  target: number
  promise: Promise<HistoryEntry[]>
} | null = null

function entryMode(entry: HistoryEntry): HistoryMode {
  return getModeFromInput(entry.display)
}

async function loadEntries(
  count: number,
  filter: HistoryMode | undefined,
): Promise<HistoryEntry[]> {
  const target = Math.ceil(count / CHUNK) * CHUNK
  if (loadedFilter === filter && (loadedEntries.length >= target || loadExhausted)) {
    return loadedEntries
  }
  if (pendingLoad !== null) {
    // A pending load that already satisfies count+filter is awaited
    // directly; otherwise it must finish before a new one starts.
    if (pendingLoad.filter === filter && pendingLoad.target >= target) {
      return pendingLoad.promise
    }
    await pendingLoad.promise.catch(() => {})
  }
  const load = (async (): Promise<HistoryEntry[]> => {
    if (loadedFilter !== filter) {
      loadedEntries = []
      loadExhausted = false
      loadedFilter = filter
    }
    const collected: HistoryEntry[] = []
    try {
      for await (const entry of getHistory()) {
        if (filter !== undefined && entryMode(entry) !== filter) continue
        collected.push(entry)
        if (collected.length >= target) break
      }
      if (collected.length < target) loadExhausted = true
    } catch (error) {
      logForDebugging(`history load failed: ${error}`)
      loadExhausted = true
    }
    loadedEntries = collected
    return collected
  })()
  pendingLoad = { filter, target, promise: load }
  try {
    return await load
  } finally {
    if (pendingLoad?.promise === load) pendingLoad = null
  }
}

export function useArrowKeyHistory(
  onSetInput: (
    value: string,
    mode: PromptInputMode,
    pastedContents: Record<number, PastedContent>,
  ) => void,
  currentInput: string,
  pastedContents: Record<number, PastedContent>,
  setCursorOffset?: (offset: number) => void,
  currentMode?: PromptInputMode,
  recallFitsOneRow?: (value: string) => boolean,
): {
  historyIndex: number
  setHistoryIndex: (index: number) => void
  onHistoryUp: () => void
  onHistoryDown: () => boolean
  resetHistory: () => void
  dismissSearchHint: () => void
} {
  const { addNotification, removeNotification } = useNotifications()
  const searchChord = useShortcutDisplay('history:search', 'Global', 'ctrl+r')
  void searchChord

  // Synchronously mirrored live values (the saved draft must reflect
  // the newest input, not a stale closure).
  const inputRef = useRef(currentInput)
  inputRef.current = currentInput
  const pastesRef = useRef(pastedContents)
  pastesRef.current = pastedContents
  const modeRef = useRef(currentMode)
  modeRef.current = currentMode
  const fitsRef = useRef(recallFitsOneRow)
  fitsRef.current = recallFitsOneRow

  const indexRef = useRef(0)
  const filterRef = useRef<HistoryMode | undefined>(undefined)
  const savedDraftRef = useRef<{
    input: string
    pastedContents: Record<number, PastedContent>
    mode: PromptInputMode | undefined
  } | null>(null)
  const hintShownRef = useRef(false)

  const applyEntry = useCallback(
    (entry: HistoryEntry): void => {
      const mode = entryMode(entry)
      // Shell-mode entries apply mode-stripped.
      const value = mode === 'bash' ? getValueFromInput(entry.display) : entry.display
      onSetInput(value, mode, entry.pastedContents)
      if (setCursorOffset) {
        const fits =
          fitsRef.current?.(value) ?? !value.includes('\n')
        setCursorOffset(fits ? value.length : 0)
      }
    },
    [onSetInput, setCursorOffset],
  )

  const onHistoryUp = useCallback((): void => {
    const wasAtBottom = indexRef.current === 0
    if (wasAtBottom) {
      // First press: fix the walk's filter and save a non-blank draft.
      filterRef.current = modeRef.current === 'bash' ? 'bash' : undefined
      if (inputRef.current.trim() !== '') {
        savedDraftRef.current = {
          input: inputRef.current,
          pastedContents: pastesRef.current,
          mode: modeRef.current,
        }
      }
    }
    // Captured and incremented synchronously.
    const requested = indexRef.current + 1
    indexRef.current = requested
    void loadEntries(requested, filterRef.current).then(entries => {
      if (indexRef.current !== requested) return
      const entry = entries[requested - 1]
      if (entry === undefined) {
        // Past the end: roll the increment back, leave the draft intact.
        indexRef.current = requested - 1
        return
      }
      applyEntry(entry)
      if (requested >= 2 && !hintShownRef.current) {
        hintShownRef.current = true
        addNotification({
          key: SEARCH_HINT_KEY,
          jsx: (
            <Text dimColor>
              <ConfigurableShortcutHint
                action="history:search"
                context="Global"
                fallback="ctrl+r"
                description="searches history"
              />
            </Text>
          ),
          priority: 'immediate',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
        })
      }
    })
  }, [applyEntry, addNotification])

  const onHistoryDown = useCallback((): boolean => {
    if (indexRef.current === 0) return true
    const next = indexRef.current - 1
    indexRef.current = next
    if (next === 0) {
      const saved = savedDraftRef.current
      if (saved !== null) {
        onSetInput(
          saved.input,
          saved.mode ?? filterRef.current ?? 'prompt',
          saved.pastedContents,
        )
        setCursorOffset?.(saved.input.length)
      } else {
        onSetInput('', filterRef.current ?? 'prompt', {})
        setCursorOffset?.(0)
      }
      return false
    }
    void loadEntries(next, filterRef.current).then(entries => {
      if (indexRef.current !== next) return
      const entry = entries[next - 1]
      if (entry === undefined) return
      applyEntry(entry)
      // Down-recall always lands the cursor at the end.
      const mode = entryMode(entry)
      const value = mode === 'bash' ? getValueFromInput(entry.display) : entry.display
      setCursorOffset?.(value.length)
    })
    return false
  }, [applyEntry, onSetInput, setCursorOffset])

  const dismissSearchHint = useCallback((): void => {
    removeNotification(SEARCH_HINT_KEY)
  }, [removeNotification])

  const resetHistory = useCallback((): void => {
    indexRef.current = 0
    filterRef.current = undefined
    savedDraftRef.current = null
    loadedEntries = []
    loadedFilter = undefined
    loadExhausted = false
    removeNotification(SEARCH_HINT_KEY)
  }, [removeNotification])

  return {
    historyIndex: indexRef.current,
    setHistoryIndex: (index: number) => {
      indexRef.current = index
    },
    onHistoryUp,
    onHistoryDown,
    resetHistory,
    dismissSearchHint,
  }
}
