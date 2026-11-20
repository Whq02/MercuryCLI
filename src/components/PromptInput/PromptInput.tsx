
import React, {
  useCallback,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { useTypeahead } from '../../hooks/useTypeahead.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import type { AgentDefinition } from '../../types/agent.js'
import * as pendingInput from '../../input-core/pending-input.js'
import type { AppState } from '../../state/AppState.js'
import type { PastedContent } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import type { VimMode } from '../../types/textInputTypes.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'
import { useCrewBanner } from './useCrewBanner.js'
import { useComposerSubmit } from './useComposerSubmit.js'
import { useComposerRawKeys } from './useComposerRawKeys.js'
import { useComposerKeybindings } from './useComposerKeybindings.js'
import { useComposerSelectionRoad } from './useComposerSelection.js'
import { popupOwnsKeys, subscribePopupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { fluxMark } from '../../utils/flux/fluxProbe.js'
import { useComposerHoldToTalk } from './useComposerVoice.js'
import { useComposerCompactFocus } from './useComposerCompactFocus.js'
import { useComposerHistory } from './useComposerHistory.js'
import { useComposerHelm } from './useComposerHelm.js'
import { useComposerHighlights } from './useComposerHighlights.js'
import { useComposerEffortNotice } from './useComposerEffortNotice.js'
import { composerSurface } from './composerSurface.js'
import { composerFrame, composerGeometry } from './composerFrame.js'
import { useComposerState } from './useComposerState.js'
import { useComposerWiring } from './useComposerWiring.js'
import { composerGates, composerInputBody, composerTextInputProps, composerView } from './composerView.js'
import type { CompactWorkControls, CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'

export type PromptInputProps = {
  compactWork?: CompactWorkControls
  compactFocus?: CompactWorkFocus
  debug: boolean
  toolPermissionContext: AppState['toolPermissionContext']
  setToolPermissionContext: (
    context: AppState['toolPermissionContext'],
    options?: { preserveMode?: boolean },
  ) => void
  apiKeyStatus: VerificationStatus
  commands: Command[]
  agents: AgentDefinition[] | undefined
  isLoading: boolean
  verbose: boolean
  submitCount: number
  onShowMessageSelector: () => void
  onMessageActionsEnter?: () => void
  mcpClients: MCPServerConnection[]
  vimMode: VimMode
  setVimMode: React.Dispatch<React.SetStateAction<VimMode>>
  showBashesDialog: string | boolean
  setShowBashesDialog: React.Dispatch<React.SetStateAction<string | boolean>>
  onExit: () => void
  getToolUseContext: (
    messages: Message[],
    tools: never[],
    abortController: AbortController,
    model: string,
  ) => LocalJSXCommandContext
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: unknown
      speculationSessionTimeSavedMs: number
      setAppState: (f: (prev: AppState) => AppState) => void
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  isSearchingHistory: boolean
  setIsSearchingHistory: (searching: boolean) => void
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  hasSuppressedDialogs: boolean
  isLocalJSXCommandActive: boolean
  insertTextRef: React.MutableRefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
  onAgentSubmit?: (text: string) => void
}

function PromptInputInner(props: PromptInputProps): React.ReactNode {
  fluxMark('render:composer')
  const {
    compactWork,
    compactFocus = 'composer',
    debug,
    toolPermissionContext,
    setToolPermissionContext,
    apiKeyStatus,
    commands,
    agents,
    isLoading,
    verbose,
    submitCount,
    onShowMessageSelector,
    onMessageActionsEnter,
    mcpClients,
    vimMode,
    setVimMode,
    showBashesDialog,
    onExit,
    getToolUseContext,
    onSubmit,
    isSearchingHistory,
    setIsSearchingHistory,
    helpOpen,
    setHelpOpen,
    hasSuppressedDialogs,
    isLocalJSXCommandActive,
    insertTextRef,
    onAgentSubmit,
  } = props

  const { composerBloom, theme, columns, rows, isCompact, compactBudget, keybindings, pastePendingRef, summaryVisible, addNotification, removeNotification, setAppState, appStateStore, messages, engineModel, engineModelForSession, effortValue, viewedTask, footerSelection, speculationActive, fullscreen, cockpitActive, draft, input, mode, pastedContents, stash, cursorOffset, setCursorOffset, lastSelfWriteRef, writeDraft, buffer, setMode, setPastedContents, deferredSpaceArmedRef, deferredSpaceShiftRef, onChange, focusedMainModel, focusedEffectiveModel, seatEffort, sentEffort, bornEffort, voice, selection, inputSelectionRangeRef, inputBoxRef, selectionApi, clearOwnSelection, overlay, setOverlay, showCommandPalette, setShowCommandPalette, showFileOpen, setShowFileOpen, showContentSearch, setShowContentSearch, externalEditorActive, setExternalEditorActive, exitState, setExitState, isPasting, setIsPasting } = useComposerState({ props, helpOpen, setHelpOpen })

  const popupUp = useSyncExternalStore(subscribePopupOwnsKeys, popupOwnsKeys, popupOwnsKeys)
  const modalOverlayUp =
    overlay !== null ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive ||
    hasSuppressedDialogs ||
    popupUp

  const canFocusSummary = useComposerCompactFocus({ compactWork, summaryVisible, modalOverlayUp, externalEditorActive, isSearchingHistory, helpOpen, exitState, pastePendingRef, isCompact, footerSelection, setAppState })

  const { doors, capLaneLine, capLaneCut, composerCrewmateRef, viewedCrewmateRef, commandCrewmateRef, viewedAgentName, viewedAgentColor, suggestionApi, insertAtCursor, insertAtomic, handleImagePaste, handleImageError, handleTextPaste, cursorRef, suggestionsState, setSuggestionsState, suggestionsMirrorRef } = useComposerWiring({ overlay, setOverlay, messages, modalOverlayUp, engineModel, engineModelForSession, focusedMainModel, focusedEffectiveModel, isCompact, columns, appStateStore, setAppState, addNotification, viewedTask, input, isLoading, mode, cursorOffset, draft, pastedContents, buffer, rows, inputSelectionRangeRef, writeDraft, setCursorOffset, setMode, setPastedContents, deferredSpaceArmedRef, insertTextRef })

  const historyRecallActiveRef = useRef(false)
  const typeahead = useTypeahead({
    input,
    cursorOffset,
    commands,
    mode,
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

  const { history, recallQueuedSend, helpers } = useComposerHistory({ input, pastedContents, mode, onChange, setMode, setCursorOffset, buffer, columns, isCompact, compactBudget, historyRecallActiveRef, addNotification })

  const historySearch = useHistorySearch(
    entry => {
      const display = entry.display
      pendingInput.setPastedContents(entry.pastedContents ?? {})
      void submit(display, {})
    },
    input,
    (value: string) => {
      writeDraft(value)
    },
    setCursorOffset,
    cursorOffset,
    setMode,
    mode,
    isSearchingHistory,
    setIsSearchingHistory,
    (next: Record<number, PastedContent>) => pendingInput.setPastedContents(next),
    pastedContents,
  )

  const historyNavAllowed = (edge: 'first' | 'last'): boolean => {
    if (suggestionsMirrorRef.current.suggestions.length > 1) return false
    const firstNewline = input.indexOf('\n')
    if (firstNewline === -1) return true
    if (edge === 'first') return cursorOffset <= firstNewline
    return cursorOffset > input.lastIndexOf('\n')
  }
  const submit = useComposerSubmit({
    compactWork,
    appStateStore,
    suggestionApi,
    commands,
    helpers,
    buffer,
    history,
    onSubmit,
    onAgentSubmit,
    setAppState,
    setCursorOffset,
    addNotification,
    removeNotification,
    composerCrewmateRef,
    commandCrewmateRef,
    suggestionsMirrorRef,
    writeDraft,
  })

  const { surfaceCovered, submitRef } = useComposerHelm({ submit, setAppState })

  const { performUndo, crewmateFooterIndex } = useComposerKeybindings({
    buffer,
    input,
    cursorOffset,
    pastedContents,
    writeDraft,
    lastSelfWriteRef,
    setCursorOffset,
    addNotification,
    setExternalEditorActive,
    setOverlay,
    setHelpOpen,
    helpOpen,
    modalOverlayUp,
    isSearchingHistory,
    isLoading,
    speculationActive,
    onMessageActionsEnter,
    appStateStore,
    setAppState,
    toolPermissionContext,
    setToolPermissionContext,
    footerSelection,
    insertAtCursor,
    handleImagePaste,
    handleImageError,
    setShowCommandPalette,
    setShowFileOpen,
    setShowContentSearch,
    commandCrewmateRef,
  })

  useComposerRawKeys({
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
    voicePhase: voice.phase,
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
  })


  const highlights = useComposerHighlights({ isSearchingHistory, historySearch, input, cursorOffset, commands, mcpClients })

  useComposerEffortNotice({ focusedEffectiveModel, engineModel, focusedMainModel, seatEffort, sentEffort, effortValue, bornEffort, addNotification, removeNotification })

  const placeholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName: viewedAgentName,
    cockpitActive,
    compact: isCompact,
  })
  const banner = useCrewBanner()
  const { borderStyle, borderColor, compactTransientRows, compactSuggestionRows, maxVisibleLines, textColumns } = composerGeometry({ isCompact, compactBudget, rows, columns, toolPermissionContext, mode, input, typeahead, fullscreen })
  const composerViewportStartRef = useRef<number | undefined>(undefined)
  const { ownSelection, handleInputBoxClick, handleInputTextGesture } = useComposerSelectionRoad(selection, {
    input,
    cursorOffset,
    textColumns,
    maxVisibleLines,
    composerViewportStartRef,
    isSearchingHistory,
    setCursorOffset,
  })
  const pushAtomic = buffer.pushAtomic

  const exitStateChange = useCallback((show: boolean, keyName?: string): void => {
    setExitState({ pending: show, keyName: keyName ?? null })
  }, [])

  const voiceInputFilter = useComposerHoldToTalk({ cursorRef, writeDraft, setCursorOffset })
  const surface = composerSurface({ externalEditorActive, borderStyle, borderColor, overlay, setOverlay, getToolUseContext, messages, engineModel, showCommandPalette, setShowCommandPalette, showFileOpen, setShowFileOpen, showContentSearch, setShowContentSearch, commands, historySearch, commandCrewmateRef, setAppState, addNotification, insertAtomic, doors, appStateStore })
  if (surface !== null) return surface

  const { searchField, helmOnPrompt, keyboardOwnedByOverlay, inputAvailable, inputFocused, showCursor, vimEnabled } = composerGates({ isSearchingHistory, historySearch, overlay, showCommandPalette, showFileOpen, showContentSearch, showBashesDialog, isLocalJSXCommandActive, popupUp, footerSelection, surfaceCovered, compactFocus })

  const textInputProps = composerTextInputProps({ composerViewportStartRef, input, onChange, cursorOffset, deferredSpaceShiftRef, setCursorOffset, textColumns, pastePendingRef, compactWork, keyboardOwnedByOverlay, isSearchingHistory, helmOnPrompt, keybindings, isCompact, inputAvailable, summaryVisible, voiceInputFilter, submit, setMode, setHelpOpen, onExit, history, exitStateChange, historyNavAllowed, recallQueuedSend, footerSelection, suggestionsMirrorRef, canFocusSummary, appStateStore, setAppState, handleTextPaste, handleImagePaste, handleImageError, setIsPasting, inputFocused, showCursor, suggestionApi, mode, viewedAgentName, placeholder, highlights, composerBloom, typeahead, maxVisibleLines, performUndo })

  const inputBody = composerInputBody({ isCompact, maxVisibleLines, compactBudget, mode, isLoading, input, viewedAgentName, viewedAgentColor, inputBoxRef, handleInputBoxClick, handleInputTextGesture, vimEnabled, textInputProps, vimMode, setVimMode, inputSelectionRangeRef, ownSelection, clearOwnSelection, selectionApi, pushAtomic, cursorOffset, pastedContents })

  const frame = composerFrame({ banner, columns, isCompact, inputBody, borderStyle, theme, borderColor, input })


  return composerView({ isCompact, compactTransientRows, capLaneLine, capLaneCut, hasSuppressedDialogs, frame, summaryVisible, compactWork, columns, compactFocus, vimEnabled, vimMode, canFocusSummary, stash, fullscreen, apiKeyStatus, debug, verbose, messages, mcpClients, input, helpOpen, compactBudget, compactSuggestionRows, typeahead, mode, isLoading, exitState, isPasting, searchField, isSearchingHistory, crewmateFooterIndex, setOverlay })
}

const PromptInput = React.memo(PromptInputInner)
export default PromptInput
