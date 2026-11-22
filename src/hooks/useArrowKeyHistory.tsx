import { useCallback, useRef } from 'react'
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
import { passedOver } from '../utils/passedOver.js'
import { notBuilt } from '../pi/holes.js'

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
  return notBuilt('src/hooks/useArrowKeyHistory.tsx:93')
}
