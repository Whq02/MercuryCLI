import type React from 'react'
import { useCallback } from 'react'
import { useInput } from '../../ink.js'
import type { Key } from '../../ink/events/input-event.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { Notification } from '../../context/notifications.js'
import { currentSurfaceRoute, isPriorGenerationInput } from '../../context/surfaceRoute.js'
import { useDoublePress } from '../../hooks/useDoublePress.js'
import { cancelVoiceCapture } from '../../services/voice/voiceSession.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import { clearMainChat, enterCrewmateView, exitCrewmateView, setMainChat } from '../../state/crewmateViewHelpers.js'
import type { useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { crewClearedWords, crewClearRefusedWords, crewmateEscBackWords, crewmateInterruptedWords, crewmateInterruptRefusedWords } from '../../utils/cockpit/crewmateWords.js'
import { crewStateLabel } from '../../services/engine-connector/crewFacts.js'
import { clearCrewmate } from '../../state/crewLedger.js'
import { interruptCrewmate } from '../tasks/crewmateInterrupt.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { Message } from '../../types/message.js'
import {
  currentHelmRow,
  cycleHelmFocus,
  getHelmCursor,
  getHelmFocus,
  helmRailPastEntryBuffer,
  moveHelmCursor,
  nextHelmPane,
  requestHelmRowActivation,
  setHelmFocus,
} from '../../utils/cockpit/helmFocus.js'
import {
  beginConsoleCompose,
  consoleAbortAsk,
  consoleBackspace,
  consoleClear,
  consoleCursorEnd,
  consoleCursorHome,
  consoleDeleteForward,
  consoleEnabled,
  consoleHistoryMove,
  consoleInsert,
  consoleKillLine,
  consoleKillWord,
  consoleMoveCursor,
  consoleSubmitBuffer,
  exitConsoleCompose,
  getConsoleBuffer,
  isConsoleComposing,
} from '../../utils/cockpit/helmConsole.js'
import { runConsoleAsk } from '../../utils/cockpit/helmConsoleAsk.js'
import { popupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import { getPlatform } from '../../utils/platform.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { SuggestionsState } from '../../hooks/useTypeahead.js'
import type { ComposerSubmit } from './useComposerSubmit.js'

const SESSION_TAB_COMMAND = '/sessiontab'
const KEYSETUP_COMMAND = '/keysetup'

export type ComposerRawKeysInput = {
  modalOverlayUp: boolean
  compactWork: CompactWorkControls | undefined
  input: string
  cursorOffset: number
  mode: PromptInputMode
  footerSelection: AppState['footerSelection']
  helpOpen: boolean
  isSearchingHistory: boolean
  messages: Message[]
  isLoading: boolean
  speculationActive: boolean
  appStateStore: AppStateStore
  engineModel: string | null
  cockpitActive: boolean
  voicePhase: string
  getToolUseContext: (
    messages: Message[],
    tools: never[],
    abortController: AbortController,
    model: string,
  ) => LocalJSXCommandContext
  insertAtCursor: (text: string) => void
  setMode: (next: PromptInputMode) => void
  setHelpOpen: (open: boolean) => void
  setCursorOffset: (offset: number) => void
  setAppState: (f: (prev: AppState) => AppState) => void
  addNotification: (notification: Notification) => void
  onShowMessageSelector: () => void
  submitRef: React.MutableRefObject<ComposerSubmit>
  suggestionsMirrorRef: React.MutableRefObject<SuggestionsState>
  viewedCrewmateRef: React.MutableRefObject<ReturnType<typeof useViewedCrewmate>>
}

export function useComposerRawKeys({
  modalOverlayUp,
  compactWork,
  input,
  cursorOffset,
  mode,
  footerSelection,
  helpOpen,
  isSearchingHistory,
  messages,
  isLoading,
  speculationActive,
  appStateStore,
  engineModel,
  cockpitActive,
  voicePhase,
  getToolUseContext,
  insertAtCursor,
  setMode,
  setHelpOpen,
  setCursorOffset,
  setAppState,
  addNotification,
  onShowMessageSelector,
  submitRef,
  suggestionsMirrorRef,
  viewedCrewmateRef,
}: ComposerRawKeysInput): void {
  const escapeDoublePress = useDoublePress(
    () => {},
    () => {
      onShowMessageSelector()
    },
  )
  const handleRawKey = useCallback(
    (
      rawInput: string,
      key: Key,
      event: { stopImmediatePropagation: () => void; seq?: number },
    ): void => {
      if (modalOverlayUp || popupOwnsKeys() || compactWork?.read() === 'summary' || compactWork?.read() === 'detail') return
      if (currentSurfaceRoute().kind !== 'repl') return
      if (event.seq !== undefined && isPriorGenerationInput(event.seq)) return

      const focusPane = getHelmFocus()

      if (focusPane !== 'prompt') {
        const composing = focusPane === 'telemetry' && isConsoleComposing()
        if (composing) {
          event.stopImmediatePropagation()
          if (key.escape) {
            if (!consoleAbortAsk()) exitConsoleCompose()
            return
          }
          if (key.tab) {
            exitConsoleCompose()
            setHelmFocus(nextHelmPane(focusPane))
            return
          }
          if (key.return) {
            const buffered = getConsoleBuffer()
            if (buffered.trim() !== '') {
              const context = getToolUseContext(
                messages,
                [],
                new AbortController(),
                engineModel ?? '',
              )
              consoleSubmitBuffer((question, controller) =>
                runConsoleAsk({
                  question,
                  context,
                  abortController: controller,
                }),
              )
            }
            return
          }
          if (key.backspace || rawInput === '\u007f') {
            consoleBackspace()
            return
          }
          if (key.delete) {
            consoleDeleteForward()
            return
          }
          if (key.leftArrow) {
            consoleMoveCursor(-1)
            return
          }
          if (key.rightArrow) {
            consoleMoveCursor(1)
            return
          }
          if (key.ctrl && rawInput === 'a') {
            consoleCursorHome()
            return
          }
          if (key.ctrl && rawInput === 'e') {
            consoleCursorEnd()
            return
          }
          if (key.ctrl && rawInput === 'k') {
            consoleKillLine()
            return
          }
          if (key.ctrl && rawInput === 'w') {
            consoleKillWord()
            return
          }
          if (key.ctrl && rawInput === 'l') {
            consoleClear()
            return
          }
          if (key.upArrow) {
            consoleHistoryMove(-1)
            return
          }
          if (key.downArrow) {
            consoleHistoryMove(1)
            return
          }
          if (
            rawInput !== '' &&
            !key.ctrl &&
            !key.meta &&
            rawInput >= ' '
          ) {
            consoleInsert(rawInput)
          }
          return
        }
        if (key.escape) {
          event.stopImmediatePropagation()
          setHelmFocus('prompt')
          return
        }
        if (key.tab) {
          event.stopImmediatePropagation()
          cycleHelmFocus()
          return
        }
        if (key.upArrow || key.downArrow) {
          event.stopImmediatePropagation()
          moveHelmCursor(focusPane, key.downArrow ? 1 : -1)
          return
        }
        if (key.return) {
          event.stopImmediatePropagation()
          if (!helmRailPastEntryBuffer()) return
          requestHelmRowActivation(focusPane, getHelmCursor(focusPane))
          return
        }
        if (rawInput === 'm' && !key.ctrl && !key.meta && focusPane === 'lanes') {
          const row = currentHelmRow('lanes')
          if (row !== undefined && (row.kind === 'crewmate' || row.kind === 'main')) {
            event.stopImmediatePropagation()
            if (!helmRailPastEntryBuffer()) return
            if (row.kind === 'main') clearMainChat(setAppState)
            else {
              setMainChat(row.id, setAppState)
              enterCrewmateView(row.id, setAppState)
            }
            setHelmFocus('prompt')
            return
          }
        }
        if (rawInput === 'c' && !key.ctrl && !key.meta && focusPane === 'lanes') {
          const row = currentHelmRow('lanes')
          if (row !== undefined && row.kind === 'crewmate') {
            event.stopImmediatePropagation()
            if (!helmRailPastEntryBuffer()) return
            const ledgerRow = (appStateStore.getState() as AppState).crewLedger[row.id]
            const facts = ledgerRow?.facts ?? { name: row.id, running: true }
            const cleared = clearCrewmate(row.id, setAppState)
            addNotification({ key: 'crewmate-send', text: cleared ? crewClearedWords(facts.name) : crewClearRefusedWords(facts), priority: 'medium', timeoutMs: 5000, fold: (_accumulated, incoming) => incoming })
            return
          }
        }
        if (
          rawInput !== '' &&
          !key.ctrl &&
          !key.meta &&
          rawInput >= ' ' &&
          !key.tab
        ) {
          const composeCapable = focusPane === 'telemetry' && consoleEnabled()
          event.stopImmediatePropagation()
          if (composeCapable) {
            beginConsoleCompose(rawInput)
          } else {
            setHelmFocus('prompt')
            insertAtCursor(rawInput)
          }
          return
        }
        return
      }

      const emptyPlainPrompt =
        input === '' && cursorOffset === 0 && mode === 'prompt' &&
        footerSelection === null && !helpOpen && !isSearchingHistory

      if (key.escape && voicePhase !== 'recording' && mode === 'prompt' && footerSelection === null && !helpOpen && !isSearchingHistory) {
        const freshState = appStateStore.getState() as AppState
        const viewed = freshState.viewingAgentTaskId
        if (viewed !== undefined) {
          event.stopImmediatePropagation()
          const crewmate = viewedCrewmateRef.current?.taskId === viewed ? viewedCrewmateRef.current : null
          const name = crewmate?.name ?? viewed
          const say = (text: string): void => addNotification({ key: 'crewmate-send', text, priority: 'medium', timeoutMs: 5000, fold: (_accumulated, incoming) => incoming })
          const road = interruptCrewmate(viewed, freshState, setAppState, undefined, {
            facts: crewmate?.facts ?? null,
            onRefused: detail => say(crewmateInterruptRefusedWords(name, detail)),
          })
          if (road === 'idle') {
            exitCrewmateView(setAppState)
            say(crewmateEscBackWords(name, crewmate?.facts != null ? crewStateLabel(crewmate.facts) : 'between turns'))
            return
          }
          say(crewmateInterruptedWords(name))
          return
        }
      }

      if (voicePhase === 'recording' && key.escape) {
        event.stopImmediatePropagation()
        cancelVoiceCapture()
        return
      }

      if (
        key.tab &&
        !key.shift &&
        emptyPlainPrompt &&
        suggestionsMirrorRef.current.suggestions.length === 0
      ) {
        if (cockpitActive) {
          event.stopImmediatePropagation()
          setHelmFocus('lanes')
          return
        }
      }

      if (
        emptyPlainPrompt &&
        key.meta &&
        !key.ctrl &&
        (key.leftArrow || key.rightArrow)
      ) {
        event.stopImmediatePropagation()
        void submitRef.current(SESSION_TAB_COMMAND, { fromKeybinding: true })
        return
      }

      if (getPlatform() === 'macos' && rawInput.length === 1 && 'åß∂ƒ©˙∆˚¬…æ∑'.includes(rawInput)) {
        addNotification({
          key: 'option-meta-hint',
          text: `option produced “${rawInput}” — run ${KEYSETUP_COMMAND} to make option send meta`,
          priority: 'low',
          timeoutMs: 5000,
        })
      }

      if (
        footerSelection !== null &&
        rawInput !== '' &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        rawInput >= ' '
      ) {
        event.stopImmediatePropagation()
        insertAtCursor(rawInput)
        return
      }

      if (
        cursorOffset === 0 &&
        (key.escape || key.backspace || key.delete || (key.ctrl && rawInput === 'u'))
      ) {
        if (mode === 'bash') {
          setMode('prompt')
          setHelpOpen(false)
        } else if (helpOpen && (key.backspace || key.delete) && input === '') {
          setHelpOpen(false)
        }
      }

      if (key.escape) {
        if (speculationActive) {
          abortSpeculation(setAppState)
          event.stopImmediatePropagation()
          return
        }
        if (helpOpen) {
          setHelpOpen(false)
          event.stopImmediatePropagation()
          return
        }
        if (footerSelection !== null) return
        if (messages.length > 0 && input === '' && !isLoading) {
          escapeDoublePress()
        }
        return
      }

      if (key.return && helpOpen) {
        setHelpOpen(false)
      }
    },
    [modalOverlayUp, input, cursorOffset, mode, footerSelection, helpOpen, isSearchingHistory, messages, isLoading, speculationActive, appStateStore, engineModel, cockpitActive, getToolUseContext, insertAtCursor, setMode, setHelpOpen, setCursorOffset, setAppState, addNotification, escapeDoublePress, voicePhase],
  )
  useInput((rawInput, key, event) => {
    handleRawKey(rawInput, key, event)
  })
}
