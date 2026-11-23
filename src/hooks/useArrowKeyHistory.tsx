import { useCallback, useRef } from 'react'
import { Text } from '../ink.js'
import { getHistory } from '../history.js'
import type { HistoryEntry, PastedContent } from '../utils/config.js'
import { useNotifications } from '../context/notifications.js'
import { FOOTER_TEMPORARY_STATUS_TIMEOUT } from '../components/PromptInput/Notifications.js'
import { ConfigurableShortcutHint } from '../components/ConfigurableShortcutHint.js'
import {
  getModeFromInput,
  getValueFromInput,
} from '../components/PromptInput/inputModes.js'
import type { PromptInputMode } from '../types/textInputTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { passedOver } from '../utils/passedOver.js'

export type HistoryMode = PromptInputMode

const CHUNK = 10
const SEARCH_HINT_KEY = 'history-search-hint'

let loadedEntries: HistoryEntry[] = []
let loadedFilter: HistoryMode | undefined
let loadExhausted = false
let loadGeneration = 0
let pendingLoad: {
  filter: HistoryMode | undefined
  target: number
  generation: number
  promise: Promise<HistoryEntry[]>
} | null = null

function dropLoadedEntries(): void {
  loadedEntries = []
  loadedFilter = undefined
  loadExhausted = false
  loadGeneration++
}

function entryMode(entry: HistoryEntry): HistoryMode {
  return getModeFromInput(entry.display)
}

async function loadHistoryEntries(
  needed: number,
  filter: HistoryMode | undefined,
): Promise<HistoryEntry[]> {
  const target = Math.ceil(needed / CHUNK) * CHUNK

  if (loadedFilter !== filter) {
    loadedEntries = []
    loadedFilter = filter
    loadExhausted = false
    loadGeneration++
  }

  if (loadedEntries.length >= target || loadExhausted) {
    return loadedEntries
  }

  while (pendingLoad !== null) {
    if (
      pendingLoad.filter === filter &&
      pendingLoad.generation === loadGeneration &&
      pendingLoad.target >= target
    ) {
      return pendingLoad.promise
    }
    await pendingLoad.promise.catch(passedOver)
    if (loadedFilter !== filter) {
      loadedEntries = []
      loadedFilter = filter
      loadExhausted = false
      loadGeneration++
    }
    if (loadedEntries.length >= target || loadExhausted) {
      return loadedEntries
    }
  }

  const generation = loadGeneration
  const run = (async (): Promise<HistoryEntry[]> => {
    const collected: HistoryEntry[] = []
    let exhausted = false
    try {
      for await (const entry of getHistory()) {
        if (filter !== undefined && entryMode(entry) !== filter) continue
        collected.push(entry)
        if (collected.length >= target) break
      }
      if (collected.length < target) exhausted = true
    } catch (error) {
      logForDebugging(`history load failed: ${String(error)}`)
      exhausted = true
    }
    if (generation === loadGeneration) {
      loadedEntries = collected
      loadedFilter = filter
      loadExhausted = exhausted
    }
    return collected
  })()

  const handle = { filter, target, generation, promise: run }
  pendingLoad = handle
  try {
    return await run
  } finally {
    if (pendingLoad === handle) pendingLoad = null
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
  const historyIndexRef = useRef(0)
  const filterModeRef = useRef<HistoryMode | undefined>(undefined)
  const savedDraftRef = useRef<
    | {
        display: string
        mode: PromptInputMode
        pastedContents: Record<number, PastedContent>
      }
    | undefined
  >(undefined)
  const searchHintShownRef = useRef(false)

  const applyEntry = useCallback(
    (entry: HistoryEntry, forceEndCursor: boolean) => {
      const mode = entryMode(entry)
      const value =
        mode === 'bash' ? getValueFromInput(entry.display) : entry.display
      onSetInput(value, mode, entry.pastedContents ?? {})
      if (forceEndCursor) {
        setCursorOffset?.(value.length)
      } else {
        const fits = recallFitsOneRow
          ? recallFitsOneRow(value)
          : !value.includes('\n')
        setCursorOffset?.(fits ? value.length : 0)
      }
    },
    [onSetInput, setCursorOffset, recallFitsOneRow],
  )

  const setHistoryIndex = useCallback((index: number) => {
    historyIndexRef.current = index
  }, [])

  const onHistoryUp = useCallback(() => {
    if (historyIndexRef.current === 0) {
      dropLoadedEntries()
      filterModeRef.current = currentMode === 'bash' ? 'bash' : undefined
      if (currentInput.trim() !== '') {
        savedDraftRef.current = {
          display: currentInput,
          mode: currentMode ?? 'prompt',
          pastedContents,
        }
      } else {
        savedDraftRef.current = undefined
      }
    }

    const nextIndex = historyIndexRef.current + 1
    historyIndexRef.current = nextIndex
    const filter = filterModeRef.current

    void loadHistoryEntries(nextIndex, filter).then(entries => {
      if (historyIndexRef.current !== nextIndex) return
      const entry = entries[nextIndex - 1]
      if (!entry) {
        historyIndexRef.current = nextIndex - 1
        return
      }
      applyEntry(entry, false)
      if (nextIndex >= 2 && !searchHintShownRef.current) {
        searchHintShownRef.current = true
        addNotification({
          key: SEARCH_HINT_KEY,
          priority: 'immediate',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
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
        })
      }
    })
  }, [currentInput, pastedContents, currentMode, applyEntry, addNotification])

  const onHistoryDown = useCallback((): boolean => {
    if (historyIndexRef.current <= 0) return true
    const nextIndex = historyIndexRef.current - 1
    historyIndexRef.current = nextIndex
    if (nextIndex === 0) {
      const saved = savedDraftRef.current
      savedDraftRef.current = undefined
      const restoreMode = filterModeRef.current ?? 'prompt'
      filterModeRef.current = undefined
      if (saved) {
        onSetInput(saved.display, saved.mode, saved.pastedContents)
        setCursorOffset?.(saved.display.length)
      } else {
        onSetInput('', restoreMode, {})
        setCursorOffset?.(0)
      }
      return false
    }

    const filter = filterModeRef.current
    void loadHistoryEntries(nextIndex, filter).then(entries => {
      if (historyIndexRef.current !== nextIndex) return
      const entry = entries[nextIndex - 1]
      if (!entry) return
      applyEntry(entry, true)
    })
    return false
  }, [onSetInput, setCursorOffset, applyEntry])

  const resetHistory = useCallback(() => {
    historyIndexRef.current = 0
    filterModeRef.current = undefined
    savedDraftRef.current = undefined
    dropLoadedEntries()
    removeNotification(SEARCH_HINT_KEY)
  }, [removeNotification])

  const dismissSearchHint = useCallback(() => {
    removeNotification(SEARCH_HINT_KEY)
  }, [removeNotification])

  return {
    historyIndex: historyIndexRef.current,
    setHistoryIndex,
    onHistoryUp,
    onHistoryDown,
    resetHistory,
    dismissSearchHint,
  }
}
