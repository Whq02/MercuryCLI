import React, {
  useCallback,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { Command } from '../../commands/catalogue/commands.js'
import type { LocalJSXCommandContext } from '../../commands/catalogue/commands.js'
import { useHistorySearch } from './history-search/useHistorySearch.js'
import { useTypeahead } from './typeahead/useTypeahead.js'
import type { VerificationStatus } from '../../models/sign-in/credentials/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import * as pendingInput from './input-core/pending-input.js'
import type { AppState } from '../app-state/AppState.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { VimMode } from './input-core/textInput.js'
import { useComposerPlaceholder } from './useComposerPlaceholder.js'
import { useCrewBanner } from './useCrewBanner.js'
import { useComposerSubmit } from './useComposerSubmit.js'
import { useComposerRawKeys } from './useComposerRawKeys.js'
import { useComposerKeybindings } from './useComposerKeybindings.js'
import { useComposerSelectionRoad } from './useComposerSelection.js'
import { popupOwnsKeys, subscribePopupOwnsKeys } from '../cockpit/popupOwnsKeys.js'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import { useComposerHoldToTalk } from './useComposerVoice.js'
import { useComposerCompactFocus } from './useComposerCompactFocus.js'
import { useComposerHistory } from './useComposerHistory.js'
import { useComposerHelm } from './useComposerHelm.js'
import { useComposerHighlights } from './useComposerHighlights.js'
import { useComposerEffortNotice } from './useComposerEffortNotice.js'
import { composerSurface, useRunsPopup } from './composerSurface.js'
import { composerFrame, composerGeometry } from './composerFrame.js'
import { useComposerState } from './useComposerState.js'
import { useComposerWiring } from './useComposerWiring.js'
import { composerGates, composerInputBody, composerTextInputProps, composerView } from './composerView.js'
import type { CompactWorkControls, CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import type { ComposerHelpers } from './input-core/composerHelpers.js'
export type ComposerProps = {
  toolPermissionContext: AppState['toolPermissionContext']
  setToolPermissionContext: (
    context: AppState['toolPermissionContext'],
    options?: { preserveMode?: boolean },
  ) => void
  apiKeyStatus: VerificationStatus
  commands: Command[]
  agents: AgentDefinition[] | undefined
  mcpClients: MCPServerConnection[]
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    model: string,
  ) => LocalJSXCommandContext
  isLoading: boolean
  submitCount: number
  verbose: boolean
  debug: boolean
  onSubmit: (
    input: string,
    helpers: ComposerHelpers,
    speculationAccept?: {
      state: unknown
      sessionTimeSaved: number
      setAppState: (f: (prev: AppState) => AppState) => void
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  onCrewmateSubmit?: (input: string) => void | Promise<void>
  compactWork?: CompactWorkControls
  compactFocus?: CompactWorkFocus
  isSearchingHistory: boolean
  setIsSearchingHistory: (searching: boolean) => void
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  vimMode: VimMode
  setVimMode: React.Dispatch<React.SetStateAction<VimMode>>
  showBashesDialog: string | boolean
  setShowBashesDialog: React.Dispatch<React.SetStateAction<string | boolean>>
  isLocalJSXCommandActive: boolean
  hasSuppressedDialogs: boolean
  onShowRewindPicker: () => void
  onMessageActionsEnter?: () => void
  onExit: () => void
  insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
}

function ComposerInner(props: ComposerProps): React.ReactNode {
  fluxMark('render:composer')
  const {
    toolPermissionContext, setToolPermissionContext, apiKeyStatus, commands, agents,
    mcpClients, getToolUseContext, isLoading, submitCount, verbose, debug,
    onSubmit, onCrewmateSubmit, compactWork, compactFocus = 'composer',
    isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen,
    vimMode, setVimMode, showBashesDialog, isLocalJSXCommandActive,
    hasSuppressedDialogs, onShowRewindPicker, onMessageActionsEnter,
    onExit, insertTextRef,
  } = props

  const state = useComposerState({ props, helpOpen, setHelpOpen })
  const {
    composerBloom, theme, columns, rows, isCompact, compactBudget, keybindings,
    pastePendingRef, summaryVisible, addNotification, removeNotification,
    setAppState, appStateStore, messages, engineModel, engineModelForSession,
    effortValue, viewedTask, footerSelection, speculationActive, fullscreen,
    cockpitActive, draft, input, mode, pastedContents, stash, cursorOffset,
    setCursorOffset, lastSelfWriteRef, writeDraft, buffer, setMode,
    setPastedContents, deferredSpaceArmedRef, deferredSpaceShiftRef, onChange,
    focusedMainModel, focusedEffectiveModel, seatEffort, sentEffort, bornEffort,
    voice, selection, inputSelectionRangeRef, inputBoxRef, selectionApi,
    clearOwnSelection, overlay, setOverlay, showCommandPalette,
    setShowCommandPalette, showFileOpen, setShowFileOpen, showContentSearch,
    setShowContentSearch, externalEditorActive, setExternalEditorActive,
    exitState, setExitState, isPasting, setIsPasting,
  } = state

  const popupUp = useSyncExternalStore(
    subscribePopupOwnsKeys,
    popupOwnsKeys,
    popupOwnsKeys,
  )
  const modalOverlayUp =
    overlay !== null ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive ||
    hasSuppressedDialogs ||
    popupUp

  const canFocusSummary = useComposerCompactFocus({
    compactWork, summaryVisible, modalOverlayUp, externalEditorActive,
    isSearchingHistory, helpOpen, exitState, pastePendingRef,
    isCompact, footerSelection, setAppState,
  })

  const {
    doors, capLaneLine, capLaneCut, composerCrewmateRef, viewedCrewmateRef,
    commandCrewmateRef, viewedCrewmateName, suggestionApi,
    insertAtCursor, insertAtomic, handleImagePaste, handleImageError,
    handleTextPaste, cursorRef, suggestionsState, setSuggestionsState,
    suggestionsMirrorRef,
  } = useComposerWiring({
    overlay, setOverlay, messages, engineModel, engineModelForSession,
    focusedMainModel, focusedEffectiveModel, isCompact, columns, appStateStore,
    setAppState, addNotification, viewedTask, input, mode, cursorOffset,
    draft, pastedContents, buffer, rows, inputSelectionRangeRef, writeDraft,
    setCursorOffset, setMode, setPastedContents, deferredSpaceArmedRef,
    isLoading, insertTextRef, modalOverlayUp,
  })

  const historyRecallActiveRef = useRef(false)
  const typeahead = useTypeahead({
    input,
    cursorOffset,
    mode,
    commands,
    agents,
    suppressSuggestions: isSearchingHistory || historyRecallActiveRef.current,
    suggestionsState,
    setSuggestionsState,
    onInputChange: onChange,
    setCursorOffset,
    onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => {
      void submit(value, { isSlashPick: isSubmittingSlashCommand === true })
    },
    onModeChange: setMode,
    markAccepted: suggestionApi.markAccepted,
  })

  const { history, recallQueuedSend, helpers } = useComposerHistory({
    input, pastedContents, mode, onChange, setMode, setCursorOffset,
    buffer, columns, isCompact, compactBudget, historyRecallActiveRef,
    addNotification,
  })

  const historySearch = useHistorySearch(
    entry => {
      pendingInput.setPastedContents(entry.pastedContents ?? {})
      void submit(entry.display, {})
    },
    input,
    value => {
      writeDraft(value)
    },
    setCursorOffset,
    cursorOffset,
    setMode,
    mode,
    isSearchingHistory,
    setIsSearchingHistory,
    pastes => {
      pendingInput.setPastedContents(pastes)
    },
    pastedContents,
    overlay === 'tasks-dialog' || showBashesDialog !== false || isLocalJSXCommandActive,
  )

  const historyNavAllowed = useCallback(
    (edge: 'first' | 'last'): boolean => {
      if (suggestionsMirrorRef.current.suggestions.length > 1) return false
      const firstNewline = input.indexOf('\n')
      if (firstNewline === -1) return true
      if (edge === 'first') return cursorOffset <= firstNewline
      return cursorOffset > input.lastIndexOf('\n')
    },
    [input, cursorOffset, suggestionsMirrorRef],
  )

  const submit = useComposerSubmit({
    compactWork, appStateStore, setAppState, suggestionApi, commands, helpers,
    buffer, history, onSubmit, onCrewmateSubmit, setCursorOffset, writeDraft,
    addNotification, removeNotification, composerCrewmateRef,
    commandCrewmateRef, suggestionsMirrorRef,
  })

  const { surfaceCovered, submitRef } = useComposerHelm({ submit, setAppState })

  const { performUndo } = useComposerKeybindings({
    input, cursorOffset, pastedContents, buffer, writeDraft, setCursorOffset,
    lastSelfWriteRef, setOverlay, helpOpen, setHelpOpen,
    setExternalEditorActive, setShowCommandPalette, setShowFileOpen,
    setShowContentSearch, onMessageActionsEnter, isLoading, isSearchingHistory,
    speculationActive, modalOverlayUp, footerSelection, appStateStore,
    setAppState, toolPermissionContext, setToolPermissionContext,
    addNotification, insertAtCursor, handleImagePaste, handleImageError,
    commandCrewmateRef,
  })

  useComposerRawKeys({
    modalOverlayUp, compactWork, input, cursorOffset, mode, footerSelection,
    helpOpen, isSearchingHistory, messages, isLoading, speculationActive,
    appStateStore, setAppState, engineModel, cockpitActive, voicePhase: voice.phase,
    getToolUseContext, insertAtCursor, setMode, setHelpOpen, setCursorOffset,
    onShowRewindPicker, addNotification, submitRef, suggestionsMirrorRef,
    viewedCrewmateRef,
  })

  const highlights = useComposerHighlights({
    isSearchingHistory, historySearch, input, cursorOffset, commands, mcpClients,
  })

  useComposerEffortNotice({
    focusedEffectiveModel, engineModel, focusedMainModel, seatEffort,
    sentEffort, effortValue, bornEffort, addNotification, removeNotification,
  })

  const placeholder = useComposerPlaceholder({
    input, submitCount, viewingCrewmateName: viewedCrewmateName,
    redirected: composerCrewmateRef.current?.pinned === true && composerCrewmateRef.current.taskId !== viewedCrewmateRef.current?.taskId,
    cockpitActive, compact: isCompact,
  })
  const banner = useCrewBanner()

  const {
    borderStyle, borderColor, compactTransientRows, compactSuggestionRows,
    maxVisibleLines, textColumns,
  } = composerGeometry({
    isCompact, compactBudget, rows, columns, toolPermissionContext,
    mode, input, typeahead, fullscreen,
  })

  const composerViewportStartRef = useRef<number | undefined>(undefined)
  const { ownSelection, handleInputBoxClick, handleInputTextGesture } =
    useComposerSelectionRoad(selection, {
      input, cursorOffset, textColumns, maxVisibleLines,
      composerViewportStartRef, isSearchingHistory, setCursorOffset,
    })

  const exitStateChange = useCallback(
    (show: boolean, keyName?: string) => {
      setExitState({ pending: show, keyName: keyName ?? null })
    },
    [setExitState],
  )
  const voiceInputFilter = useComposerHoldToTalk({
    cursorRef, writeDraft, setCursorOffset,
  })

  useRunsPopup({ fullscreen, overlay, setOverlay, getToolUseContext, messages, engineModel })
  const surface = composerSurface({
    externalEditorActive, borderStyle, borderColor, fullscreen, overlay, setOverlay,
    getToolUseContext, messages, engineModel, showCommandPalette,
    setShowCommandPalette, showFileOpen, setShowFileOpen, showContentSearch,
    setShowContentSearch, commands, historySearch, commandCrewmateRef,
    setAppState, addNotification, insertAtomic, doors, appStateStore,
  })
  if (surface !== null) return surface

  const {
    searchField, helmOnPrompt, keyboardOwnedByOverlay, inputAvailable,
    inputFocused, showCursor, vimEnabled,
  } = composerGates({
    isSearchingHistory, historySearch, overlay, showCommandPalette,
    showFileOpen, showContentSearch, showBashesDialog, isLocalJSXCommandActive,
    popupUp, footerSelection, surfaceCovered, compactFocus,
  })

  const textInputProps = composerTextInputProps({
    composerViewportStartRef, input, onChange, cursorOffset,
    deferredSpaceShiftRef, setCursorOffset, textColumns, pastePendingRef,
    compactWork, keyboardOwnedByOverlay, isSearchingHistory, helmOnPrompt,
    keybindings, isCompact, inputAvailable, summaryVisible, voiceInputFilter,
    submit, setMode, setHelpOpen, onExit, history, exitStateChange,
    historyNavAllowed, recallQueuedSend, footerSelection, suggestionsMirrorRef,
    canFocusSummary, appStateStore, setAppState, handleTextPaste,
    handleImagePaste, handleImageError, setIsPasting, inputFocused, showCursor,
    suggestionApi, mode, viewedCrewmateName, placeholder, highlights,
    composerBloom, typeahead, maxVisibleLines, performUndo,
  })

  const inputBody = composerInputBody({
    isCompact, maxVisibleLines, compactBudget, mode, isLoading, input,
    inputBoxRef, handleInputBoxClick,
    handleInputTextGesture, vimEnabled, textInputProps, vimMode, setVimMode,
    inputSelectionRangeRef, ownSelection, clearOwnSelection, selectionApi,
    pushAtomic: buffer.pushAtomic, cursorOffset, pastedContents,
  })

  const frame = composerFrame({
    banner, columns, isCompact, inputBody, borderStyle, theme, borderColor, input,
  })

  return composerView({
    isCompact, compactTransientRows, capLaneLine, capLaneCut,
    hasSuppressedDialogs, frame, summaryVisible, compactWork, columns,
    compactFocus, vimEnabled, vimMode, canFocusSummary, stash, fullscreen,
    apiKeyStatus, debug, verbose, messages, mcpClients, input, helpOpen,
    compactBudget, compactSuggestionRows, typeahead, mode, isLoading,
    exitState, isPasting, searchField, isSearchingHistory,
    setOverlay,
  })
}

const Composer = React.memo(ComposerInner)
export default Composer
