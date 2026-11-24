import { useContext, useRef, useState, useSyncExternalStore } from 'react'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import { CompactFrameBudgetContext, useLayoutChrome } from '../fullscreen-layout/layoutChromeContext.js'
import { useNotifications } from '../notifications/notifications.js'
import { useFocusedBornEffort, useFocusedSentEffort, useFocusedServedEffort } from '../model-picker/useDisplayedSessionModel.js'
import { useFocusedTranscript } from '../focused-session/useFocusedTranscript.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useOptionalKeybindingContext } from '../keys/KeybindingContext.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../engine/connector/focusedConnector.js'
import { useAppState, useAppStateStore, useSetAppState, type AppState } from '../app-state/AppState.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js'
import { fluxWhy } from '../../integrations/media-flux/fluxProbe.js'
import { getTheme } from '../theme/theme.js'
import { useTheme } from '../theme/ThemeProvider.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import type { OverlaySurface } from './composerOverlay.js'
import type { ComposerProps } from './Composer.js'
import { useComposerDraft } from './useComposerDraft.js'
import { useComposerSelectionState } from './useComposerSelection.js'
import { useComposerVoiceReceipt } from './useComposerVoice.js'

const subscribeFocusedComposerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedComposerMainModel = (): string => getFocusedSessionConnector().modelFacts().main
const getFocusedComposerEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective

export function useComposerState({
  props,
  helpOpen,
  setHelpOpen,
}: {
  props: ComposerProps
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
}) {
  const tokens = useMercuryTokens()
  const composerBloom = tokens.accentSoft
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const { columns, rows } = useTerminalSize()
  const { isCompact } = useLayoutChrome()
  const compactBudget = useContext(CompactFrameBudgetContext)
  const keybindings = useOptionalKeybindingContext()
  const pastePendingRef = useRef<(() => boolean) | null>(null)
  const summaryVisible = isCompact && (compactBudget?.summaryRows ?? 0) > 0
  const { addNotification, removeNotification } = useNotifications()
  const setAppState = useSetAppState()
  const appStateStore = useAppStateStore()
  const messages = useFocusedTranscript() as Message[]
  const engineModel = useAppState((s: AppState) => s.engineModel)
  const engineModelForSession = useAppState(
    (s: AppState) => s.engineModelForSession,
  )
  const effortValue = useAppState((s: AppState) => s.effortValue)
  const viewedTask = useAppState((s: AppState) =>
    s.viewingCrewmateTaskId !== undefined ? s.tasks[s.viewingCrewmateTaskId] : undefined,
  )
  const footerSelection = useAppState((s: AppState) => s.footerSelection)
  const viewSelectionMode = useAppState((s: AppState) => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState((s: AppState) => s.viewingCrewmateTaskId)
  const promptSuggestionEnabled = useAppState(
    (s: AppState) => s.promptSuggestionEnabled,
  )
  const speculationActive = useAppState(
    (s: AppState) =>
      (s as { speculation?: { status?: string } }).speculation?.status === 'active',
  )
  const fullscreen = isFullscreenEnvEnabled()
  const cockpitActive = useContext(CockpitActiveContext)

  const draft = useComposerDraft({
    helpOpen,
    setHelpOpen,
    speculationActive,
    footerSelection,
    setAppState,
    addNotification,
    removeNotification,
  })
  const {
    editGen,
    input,
    mode,
    pastedContents,
    stash,
    cursorOffset,
    setCursorOffset,
    lastSelfWriteRef,
    writeDraft,
    buffer,
    setMode,
    setPastedContents,
    deferredSpaceArmedRef,
    deferredSpaceShiftRef,
    onChange,
  } = draft
  const focusedMainModel = useSyncExternalStore(
    subscribeFocusedComposerModel,
    getFocusedComposerMainModel,
    getFocusedComposerMainModel,
  )
  const focusedEffectiveModel = useSyncExternalStore(
    subscribeFocusedComposerModel,
    getFocusedComposerEffectiveModel,
    getFocusedComposerEffectiveModel,
  )
  const seatEffort = useFocusedServedEffort()
  const sentEffort = useFocusedSentEffort()
  const bornEffort = useFocusedBornEffort()
  const voice = useComposerVoiceReceipt(addNotification)
  const composerWhyRef = useRef<Record<string, unknown> | null>(null)
  fluxWhy('composer', composerWhyRef, () => ({
    ...props,
    messages,
    editGen,
    focusedMainModel,
    tokens,
    themeName,
    columns,
    rows,
    engineModel,
    engineModelForSession,
    effortValue,
    viewedTask,
    footerSelection,
    viewSelectionMode,
    viewingAgentTaskId,
    promptSuggestionEnabled,
    speculationActive,
    cockpitActive,
    addNotification,
    removeNotification,
    setAppState,
    appStateStore,
  }))
  const selection = useComposerSelectionState()
  const { inputSelectionRangeRef, inputBoxRef, selectionApi, clearOwnSelection } = selection

  const [overlay, setOverlay] = useState<OverlaySurface>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showFileOpen, setShowFileOpen] = useState(false)
  const [showContentSearch, setShowContentSearch] = useState(false)
  const [externalEditorActive, setExternalEditorActive] = useState(false)
  const [exitState, setExitState] = useState<{ pending: boolean; keyName: string | null }>({ pending: false, keyName: null })
  const [isPasting, setIsPasting] = useState(false)
  return {
    composerBloom,
    theme,
    columns,
    rows,
    isCompact,
    compactBudget,
    keybindings,
    pastePendingRef,
    summaryVisible,
    addNotification,
    removeNotification,
    setAppState,
    appStateStore,
    messages,
    engineModel,
    engineModelForSession,
    effortValue,
    viewedTask,
    footerSelection,
    speculationActive,
    fullscreen,
    cockpitActive,
    draft,
    input,
    mode,
    pastedContents,
    stash,
    cursorOffset,
    setCursorOffset,
    lastSelfWriteRef,
    writeDraft,
    buffer,
    setMode,
    setPastedContents,
    deferredSpaceArmedRef,
    deferredSpaceShiftRef,
    onChange,
    focusedMainModel,
    focusedEffectiveModel,
    seatEffort,
    sentEffort,
    bornEffort,
    voice,
    selection,
    inputSelectionRangeRef,
    inputBoxRef,
    selectionApi,
    clearOwnSelection,
    overlay,
    setOverlay,
    showCommandPalette,
    setShowCommandPalette,
    showFileOpen,
    setShowFileOpen,
    showContentSearch,
    setShowContentSearch,
    externalEditorActive,
    setExternalEditorActive,
    exitState,
    setExitState,
    isPasting,
    setIsPasting,
  }
}
