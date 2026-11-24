import type React from 'react'
import { useCallback } from 'react'
import { useInput } from '../themedRenderer.js'
import type { Key } from '../renderer/events/input-event.js'
import type { LocalJSXCommandContext } from '../../commands/catalogue/commands.js'
import type { Notification } from '../notifications/notifications.js'
import { currentSurfaceRoute, isPriorGenerationInput } from '../routes/surfaceRoute.js'
import { useDoublePress } from '../keys/useDoublePress.js'
import { cancelVoiceCapture } from '../../integrations/voice/voiceSession.js'
import type { AppState } from '../app-state/AppState.js'
import type { AppStateStore } from '../app-state/AppStateStore.js'
import { clearMainChat, enterCrewmateView, exitCrewmateView, setMainChat } from '../../crew/crewmates/crewmateView.js'
import type { useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { crewClearedWords, crewClearRefusedWords, crewmateEscBackWords, crewmateInterruptedWords, crewmateInterruptRefusedWords } from '../cockpit/crewmateWords.js'
import { crewStateLabel } from '../../engine/connector/crewFacts.js'
import { clearCrewmate } from '../app-state/crewLedger.js'
import { interruptCrewmate } from '../tasks/crewmateInterrupt.js'
import type { InputMode } from './input-core/textInput.js'
import type { Message } from '../../engine/message-shapes/message.js'
import {
  currentHelmRow,
  cycleHelmFocus,
  getHelmCursor,
  getHelmFocus,
  helmRailPastEntryBuffer,
  moveHelmCursor,
  requestHelmRowActivation,
  setHelmFocus,
} from '../cockpit/helmFocus.js'
import { popupOwnsKeys } from '../cockpit/popupOwnsKeys.js'
import { abortSpeculation } from '../prompt-suggestion/speculation.js'
import { flipToSession } from '../../engine/connector/sessionFlip.js'
import { getPlatform } from '../../platform/environment/platform.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { SuggestionsState } from './typeahead/useTypeahead.js'
import type { ComposerSubmit } from './useComposerSubmit.js'

const KEYSETUP_COMMAND = '/keysetup'
const OPTION_META_CHARS = 'åß∂ƒ©˙∆˚¬…æ∑'

type VoicePhase = 'idle' | 'recording' | 'transcribing'

type ComposerRawKeysInput = {
  modalOverlayUp: boolean
  compactWork?: CompactWorkControls
  input: string
  cursorOffset: number
  mode: InputMode
  footerSelection: AppState['footerSelection']
  helpOpen: boolean
  isSearchingHistory: boolean
  messages: Message[]
  isLoading: boolean
  speculationActive: boolean
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
  engineModel: string | null
  cockpitActive: boolean
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    model: string,
  ) => LocalJSXCommandContext
  insertAtCursor: (text: string) => void
  setMode: (mode: InputMode) => void
  setHelpOpen: (open: boolean) => void
  setCursorOffset: (offset: number) => void
  onShowRewindPicker: () => void
  addNotification: (notification: Notification) => void
  submitRef: React.MutableRefObject<ComposerSubmit>
  suggestionsMirrorRef: React.MutableRefObject<SuggestionsState>
  viewedCrewmateRef: React.MutableRefObject<ReturnType<typeof useViewedCrewmate>>
  voicePhase: VoicePhase
}

function isPrintableRun(rawInput: string, key: Key): boolean {
  return (
    rawInput.length > 0 &&
    !key.ctrl &&
    !key.meta &&
    !key.tab &&
    !key.escape &&
    !key.return &&
    !key.backspace &&
    !key.delete &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow &&
    !key.pageUp &&
    !key.pageDown &&
    !key.home &&
    !key.end &&
    !key.wheelUp &&
    !key.wheelDown &&
    !/[\x00-\x1f\x7f]/.test(rawInput)
  )
}

export function useComposerRawKeys(params: ComposerRawKeysInput): void {
  const {
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
    setAppState,
    engineModel,
    cockpitActive,
    getToolUseContext,
    insertAtCursor,
    setMode,
    setHelpOpen,
    setCursorOffset,
    onShowRewindPicker,
    addNotification,
    suggestionsMirrorRef,
    viewedCrewmateRef,
    voicePhase,
  } = params
  const noopSetPending = useCallback(() => {}, [])
  const handleDoubleEsc = useDoublePress(noopSetPending, onShowRewindPicker, undefined, 800)

  const notifyCrew = useCallback(
    (text: string, color?: 'warning') => {
      addNotification({
        key: 'crewmate-send',
        text,
        priority: 'medium',
        timeoutMs: 5000,
        ...(color !== undefined ? { color } : {}),
        fold: (_current, incoming) => incoming,
      })
    },
    [addNotification],
  )

  useInput((rawInput, key, event) => {
    if (modalOverlayUp || popupOwnsKeys()) return
    if (compactWork !== undefined && compactWork.read() !== 'composer') return
    if (currentSurfaceRoute().kind !== 'repl') return
    if (isPriorGenerationInput(event.seq)) return

    const helmFocus = getHelmFocus()
    if (helmFocus !== 'prompt') {
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
        moveHelmCursor(helmFocus, key.downArrow ? 1 : -1)
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        if (helmRailPastEntryBuffer()) {
          requestHelmRowActivation(helmFocus, getHelmCursor(helmFocus))
        }
        return
      }
      if (helmFocus === 'lanes' && rawInput === 'm' && !key.ctrl && !key.meta) {
        const row = currentHelmRow('lanes')
        if (row !== undefined && (row.kind === 'main' || row.kind === 'crewmate')) {
          event.stopImmediatePropagation()
          if (!helmRailPastEntryBuffer()) return
          if (row.kind === 'main') {
            clearMainChat(setAppState)
          } else {
            setMainChat(row.id, setAppState)
            enterCrewmateView(row.id, setAppState)
          }
          setHelmFocus('prompt')
          return
        }
      }
      if (helmFocus === 'lanes' && rawInput === 'c' && !key.ctrl && !key.meta) {
        const row = currentHelmRow('lanes')
        if (row !== undefined && row.kind === 'crewmate') {
          event.stopImmediatePropagation()
          if (!helmRailPastEntryBuffer()) return
          const stateBefore = appStateStore.getState()
          const ledgerRow = stateBefore.crewLedger[row.id]
          const task = stateBefore.tasks[row.id]
          const name = ledgerRow?.facts.name ?? row.label
          const cleared = clearCrewmate(row.id, setAppState)
          if (cleared) {
            notifyCrew(crewClearedWords(name))
          } else {
            const running =
              (task !== undefined && task.status === 'running') ||
              ledgerRow?.facts.running === true
            notifyCrew(crewClearRefusedWords({ name, running }))
          }
          return
        }
      }
      if (isPrintableRun(rawInput, key)) {
        event.stopImmediatePropagation()
        setHelmFocus('prompt')
        insertAtCursor(rawInput)
        return
      }
      return
    }

    if (key.escape) {
      if (voicePhase === 'recording') {
        event.stopImmediatePropagation()
        cancelVoiceCapture()
        return
      }
      const viewed = viewedCrewmateRef.current
      if (
        mode === 'prompt' &&
        footerSelection === null &&
        !helpOpen &&
        !isSearchingHistory &&
        viewed !== null
      ) {
        event.stopImmediatePropagation()
        const road = interruptCrewmate(
          viewed.taskId,
          appStateStore.getState(),
          setAppState,
          undefined,
          {
            facts: viewed.facts,
            onRefused: detail => {
              notifyCrew(crewmateInterruptRefusedWords(viewed.name, detail), 'warning')
            },
          },
        )
        if (road === 'idle') {
          exitCrewmateView(setAppState)
          const label = viewed.facts !== null ? crewStateLabel(viewed.facts) : 'between turns'
          notifyCrew(crewmateEscBackWords(viewed.name, label))
        } else {
          notifyCrew(crewmateInterruptedWords(viewed.name))
        }
        return
      }
    }

    const emptyPlainPrompt =
      input === '' &&
      cursorOffset === 0 &&
      mode === 'prompt' &&
      footerSelection === null &&
      !helpOpen &&
      !isSearchingHistory

    if (
      emptyPlainPrompt &&
      cockpitActive &&
      key.tab &&
      !key.shift &&
      !key.ctrl &&
      !key.meta &&
      suggestionsMirrorRef.current.suggestions.length === 0
    ) {
      event.stopImmediatePropagation()
      setHelmFocus('lanes')
      return
    }

    if (emptyPlainPrompt && key.meta && !key.ctrl && (key.leftArrow || key.rightArrow)) {
      event.stopImmediatePropagation()
      const context = getToolUseContext(messages, [], new AbortController(), engineModel ?? '')
      const resume = context.resume
      if (!resume) return
      void flipToSession(resume).then(outcome => {
        if (!outcome.flipped && outcome.note !== undefined) {
          addNotification({
            key: 'session-flip',
            text: outcome.note,
            priority: 'medium',
            timeoutMs: 5000,
            fold: (_current, incoming) => incoming,
          })
        }
      })
      return
    }

    if (
      getPlatform() === 'macos' &&
      rawInput.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      OPTION_META_CHARS.includes(rawInput)
    ) {
      addNotification({
        key: 'option-meta-hint',
        text: `option produced "${rawInput}"; run ${KEYSETUP_COMMAND} to make option send meta`,
        priority: 'low',
        timeoutMs: 5000,
      })
    }

    if (footerSelection !== null && isPrintableRun(rawInput, key)) {
      event.stopImmediatePropagation()
      setAppState(prev => (prev.footerSelection !== null ? { ...prev, footerSelection: null } : prev))
      insertAtCursor(rawInput)
      return
    }

    if (cursorOffset === 0) {
      if (
        mode === 'bash' &&
        (key.escape || key.backspace || key.delete || (key.ctrl && rawInput === 'u'))
      ) {
        event.stopImmediatePropagation()
        setMode('prompt')
        setHelpOpen(false)
        setCursorOffset(0)
        return
      }
      if (mode === 'prompt' && input === '' && helpOpen && (key.backspace || key.delete)) {
        event.stopImmediatePropagation()
        setHelpOpen(false)
        return
      }
    }

    if (key.escape) {
      if (speculationActive) {
        event.stopImmediatePropagation()
        abortSpeculation(setAppState)
        return
      }
      if (helpOpen) {
        event.stopImmediatePropagation()
        setHelpOpen(false)
        return
      }
      if (footerSelection !== null) {
        return
      }
      if (messages.length > 0 && input === '' && !isLoading) {
        handleDoubleEsc()
        return
      }
    }

    if (key.return && helpOpen) {
      setHelpOpen(false)
    }
  })
}
