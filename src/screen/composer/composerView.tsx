import type React from 'react'
import { Box } from '../themedRenderer.js'
import type { useHistorySearch } from './history-search/useHistorySearch.js'
import type { usePromptSuggestion } from './usePromptSuggestion.js'
import type { useTypeahead } from './typeahead/useTypeahead.js'
import * as pendingInput from './input-core/pending-input.js'
import { getHelmFocus } from '../cockpit/helmFocus.js'
import type { TextHighlight } from './textHighlighting.js'
import TextInput from './text-input/TextInput.js'
import VimTextInput from './text-input/VimTextInput.js'
import { CompactWorkSummary, type CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import type { composerGeometry } from './composerFrame.js'
import { composerNotices } from './composerFrame.js'
import { composerHistoryDown, composerRouteInput } from './composerRouteInput.js'
import HistorySearchInput from './HistorySearchInput.js'
import { Notifications } from './Notifications.js'
import type { ComposerProps } from './Composer.js'
import { ComposerFooter } from './ComposerFooter.js'
import { ComposerModeIndicator } from './ComposerModeIndicator.js'
import { ComposerStashNotice } from './ComposerStashNotice.js'
import type { ComposerAttachments } from './useComposerAttachments.js'
import type { useComposerCrewmateRefs } from './useComposerCrewmateRefs.js'
import type { useComposerHistory } from './useComposerHistory.js'
import type { useComposerModelDoors } from './useComposerModelDoors.js'
import type { useComposerSelectionRoad } from './useComposerSelection.js'
import type { useComposerState } from './useComposerState.js'
import type { ComposerSubmit } from './useComposerSubmit.js'
import type { useComposerSuggestions } from './useComposerSuggestions.js'
import type { useComposerHoldToTalk } from './useComposerVoice.js'
import type { useComposerPlaceholder } from './useComposerPlaceholder.js'
import { isVimModeEnabled } from './composerConfig.js'

type ComposerState = ReturnType<typeof useComposerState>
type ComposerGates = ReturnType<typeof composerGates>
type ComposerGeometry = ReturnType<typeof composerGeometry>
type ComposerCrewmateRefs = ReturnType<typeof useComposerCrewmateRefs>

export function composerGates({
  isSearchingHistory,
  historySearch,
  overlay,
  showCommandPalette,
  showFileOpen,
  showContentSearch,
  showBashesDialog,
  isLocalJSXCommandActive,
  popupUp,
  footerSelection,
  surfaceCovered,
  compactFocus,
}: Pick<ComposerProps, 'isSearchingHistory' | 'showBashesDialog' | 'isLocalJSXCommandActive'>
  & Pick<ComposerState, 'overlay' | 'showCommandPalette' | 'showFileOpen' | 'showContentSearch' | 'footerSelection'>
  & {
    historySearch: ReturnType<typeof useHistorySearch>
    popupUp: boolean
    surfaceCovered: boolean
    compactFocus: CompactWorkFocus
  }) {
  const searchField = isSearchingHistory ? (
    <HistorySearchInput
      value={historySearch.historyQuery}
      onChange={historySearch.setHistoryQuery}
      historyFailedMatch={historySearch.historyFailedMatch}
    />
  ) : undefined
  const helmOnPrompt = getHelmFocus() === 'prompt'
  const keyboardOwnedByOverlay =
    overlay !== null ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive ||
    popupUp
  const inputAvailable = footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered && !keyboardOwnedByOverlay
  const inputFocused = inputAvailable && compactFocus === 'composer'
  const showCursor =
    footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered && !keyboardOwnedByOverlay && compactFocus === 'composer'
  const vimEnabled = isVimModeEnabled()
  return { searchField, helmOnPrompt, keyboardOwnedByOverlay, inputAvailable, inputFocused, showCursor, vimEnabled }
}

export function composerTextInputProps({
  composerViewportStartRef,
  input,
  onChange,
  cursorOffset,
  deferredSpaceShiftRef,
  setCursorOffset,
  textColumns,
  pastePendingRef,
  compactWork,
  keyboardOwnedByOverlay,
  isSearchingHistory,
  helmOnPrompt,
  keybindings,
  isCompact,
  inputAvailable,
  summaryVisible,
  voiceInputFilter,
  submit,
  setMode,
  setHelpOpen,
  onExit,
  history,
  exitStateChange,
  historyNavAllowed,
  recallQueuedSend,
  footerSelection,
  suggestionsMirrorRef,
  canFocusSummary,
  appStateStore,
  setAppState,
  handleTextPaste,
  handleImagePaste,
  handleImageError,
  setIsPasting,
  inputFocused,
  showCursor,
  suggestionApi,
  mode,
  viewedCrewmateName,
  placeholder,
  highlights,
  composerBloom,
  typeahead,
  maxVisibleLines,
  performUndo,
}: Pick<ComposerState, 'input' | 'onChange' | 'cursorOffset' | 'deferredSpaceShiftRef' | 'setCursorOffset' | 'pastePendingRef' | 'keybindings' | 'isCompact' | 'summaryVisible' | 'setMode' | 'footerSelection' | 'appStateStore' | 'setAppState' | 'setIsPasting' | 'mode' | 'composerBloom'>
  & Pick<ComposerProps, 'compactWork' | 'isSearchingHistory' | 'setHelpOpen' | 'onExit'>
  & Pick<ComposerGates, 'keyboardOwnedByOverlay' | 'helmOnPrompt' | 'inputAvailable' | 'inputFocused' | 'showCursor'>
  & Pick<ComposerGeometry, 'textColumns' | 'maxVisibleLines'>
  & Pick<ComposerAttachments, 'handleTextPaste' | 'handleImagePaste' | 'handleImageError'>
  & Pick<ReturnType<typeof useComposerHistory>, 'history' | 'recallQueuedSend'>
  & Pick<ComposerCrewmateRefs, 'viewedCrewmateName'>
  & {
    composerViewportStartRef: React.MutableRefObject<number | undefined>
    voiceInputFilter: ReturnType<typeof useComposerHoldToTalk>
    submit: ComposerSubmit
    exitStateChange: (show: boolean, keyName?: string) => void
    historyNavAllowed: (edge: 'first' | 'last') => boolean
    suggestionsMirrorRef: ReturnType<typeof useComposerSuggestions>['suggestionsMirrorRef']
    canFocusSummary: () => boolean
    suggestionApi: ReturnType<typeof usePromptSuggestion>
    placeholder: ReturnType<typeof useComposerPlaceholder>
    highlights: TextHighlight[]
    typeahead: ReturnType<typeof useTypeahead>
    performUndo: () => void
  }) {
  const textInputProps = {
    viewportStartRef: composerViewportStartRef,
    value: input,
    onChange,
    cursorOffset,
    onChangeCursorOffset: (offset: number) => {
      const shift = deferredSpaceShiftRef.current
      deferredSpaceShiftRef.current = 0
      setCursorOffset(offset + shift)
    },
    columns: textColumns,
    pastePendingRef,
    routeInput: composerRouteInput({
      compactWork,
      keyboardOwnedByOverlay,
      isSearchingHistory,
      helmOnPrompt,
      keybindings,
      isCompact,
      inputAvailable,
      summaryVisible,
    }),
    inputFilter: voiceInputFilter,
    onSubmit: (value: string) => {
      void submit(pendingInput.text() || value, {})
    },
    onClearInput: () => {
      setMode('prompt')
      setHelpOpen(false)
    },
    onExit,
    onEscape: history.historyIndex === 0 ? undefined : () => {
      onChange('')
      setCursorOffset(0)
      setMode('prompt')
      setHelpOpen(false)
      history.resetHistory()
    },
    onExitMessage: exitStateChange,
    onHistoryUp: () => {
      if (!historyNavAllowed('first')) return
      if (input === '' && recallQueuedSend()) return
      history.onHistoryUp()
    },
    onHistoryDown: composerHistoryDown({
      historyNavAllowed,
      history,
      footerSelection,
      suggestionsMirrorRef,
      isCompact,
      compactWork,
      canFocusSummary,
      appStateStore,
      setAppState,
    }),
    onHistoryReset: history.resetHistory,
    onPaste: handleTextPaste,
    onImagePaste: handleImagePaste,
    onImageError: handleImageError,
    onIsPastingChange: setIsPasting,
    focus: inputFocused,
    showCursor,
    multiline: true,
    placeholder:
      suggestionApi.suggestion !== null && mode === 'prompt' && !viewedCrewmateName
        ? suggestionApi.suggestion
        : placeholder,
    highlights,
    userTextColor: composerBloom,
    disableCursorMovementForUpDownKeys:
      footerSelection !== null || suggestionsMirrorRef.current.suggestions.length > 0,
    suppressEnterSubmit:
      typeahead.suggestions.length > 0 &&
      (typeahead.suggestionType === 'command' ||
        typeahead.suggestionType === 'custom-title' ||
        typeahead.suggestionType === 'channel-target'),
    maxVisibleLines,
    argumentHint: typeahead.commandArgumentHint,
    inlineGhostText: typeahead.inlineGhostText,
    onUndo: performUndo,
  }
  return textInputProps
}

export function composerInputBody({
  isCompact,
  maxVisibleLines,
  compactBudget,
  mode,
  isLoading,
  input,
  viewedCrewmateName,
  inputBoxRef,
  handleInputBoxClick,
  handleInputTextGesture,
  vimEnabled,
  textInputProps,
  vimMode,
  setVimMode,
  inputSelectionRangeRef,
  ownSelection,
  clearOwnSelection,
  selectionApi,
  pushAtomic,
  cursorOffset,
  pastedContents,
}: Pick<ComposerState, 'isCompact' | 'compactBudget' | 'mode' | 'input' | 'inputBoxRef' | 'inputSelectionRangeRef' | 'clearOwnSelection' | 'selectionApi' | 'cursorOffset' | 'pastedContents'>
  & Pick<ComposerProps, 'isLoading' | 'vimMode' | 'setVimMode'>
  & Pick<ComposerGeometry, 'maxVisibleLines'>
  & Pick<ComposerGates, 'vimEnabled'>
  & Pick<ComposerCrewmateRefs, 'viewedCrewmateName'>
  & Pick<ReturnType<typeof useComposerSelectionRoad>, 'ownSelection' | 'handleInputBoxClick' | 'handleInputTextGesture'>
  & {
    textInputProps: ReturnType<typeof composerTextInputProps>
    pushAtomic: ComposerState['buffer']['pushAtomic']
  }): React.ReactNode {
  const inputBody = (
    <Box flexDirection="row" maxHeight={isCompact ? maxVisibleLines : undefined} overflow={isCompact ? "hidden" : undefined}>
      <ComposerModeIndicator
        cells={isCompact ? compactBudget?.inputPrefixColumns : undefined}
        mode={mode}
        isLoading={isLoading}
        inputEmpty={input === ''}
        viewedCrewmateName={viewedCrewmateName}
      />
      <Box
        flexGrow={1}
        minWidth={0}
        ref={inputBoxRef}
        onClick={handleInputBoxClick}
        onTextGesture={handleInputTextGesture}
      >
        {vimEnabled ? (
          <VimTextInput
            {...textInputProps}
            initialMode={vimMode}
            onModeChange={setVimMode}
          />
        ) : (
          <TextInput
            {...textInputProps}
            selectionRange={() => inputSelectionRangeRef.current()}
            selectionHighlight={ownSelection}
            onSelectionConsumed={() => {
              clearOwnSelection()
              selectionApi.clearSelection()
            }}
            onBeforeRangeEdit={() => pushAtomic(input, cursorOffset, pastedContents)}
          />
        )}
      </Box>
    </Box>
  )
  return inputBody
}

export function composerView({
  isCompact,
  compactTransientRows,
  capLaneLine,
  capLaneCut,
  hasSuppressedDialogs,
  frame,
  summaryVisible,
  compactWork,
  columns,
  compactFocus,
  vimEnabled,
  vimMode,
  canFocusSummary,
  stash,
  fullscreen,
  apiKeyStatus,
  debug,
  verbose,
  messages,
  mcpClients,
  input,
  helpOpen,
  compactBudget,
  compactSuggestionRows,
  typeahead,
  mode,
  isLoading,
  exitState,
  isPasting,
  searchField,
  isSearchingHistory,
  crewmateFooterIndex,
  setOverlay,
}: Pick<ComposerState, 'isCompact' | 'summaryVisible' | 'columns' | 'stash' | 'fullscreen' | 'messages' | 'input' | 'compactBudget' | 'mode' | 'exitState' | 'isPasting' | 'setOverlay'>
  & Pick<ComposerProps, 'hasSuppressedDialogs' | 'compactWork' | 'vimMode' | 'apiKeyStatus' | 'debug' | 'verbose' | 'mcpClients' | 'helpOpen' | 'isLoading' | 'isSearchingHistory'>
  & Pick<ComposerGeometry, 'compactTransientRows' | 'compactSuggestionRows'>
  & Pick<ReturnType<typeof useComposerModelDoors>, 'capLaneLine' | 'capLaneCut'>
  & Pick<ComposerGates, 'vimEnabled' | 'searchField'>
  & {
    frame: React.ReactNode
    compactFocus: CompactWorkFocus
    canFocusSummary: () => boolean
    typeahead: ReturnType<typeof useTypeahead>
    crewmateFooterIndex: number
  }): React.ReactNode {
  return (
    <Box flexDirection="column">
      {composerNotices({ isCompact, compactTransientRows, capLaneLine, capLaneCut, hasSuppressedDialogs })}
      {frame}
      {summaryVisible && compactWork !== undefined ? <CompactWorkSummary columns={columns} focused={compactFocus === 'summary'} vimInsert={vimEnabled && vimMode === 'INSERT'} onFocus={() => { if (canFocusSummary()) compactWork.set('summary') }} /> : null}
      {!isCompact ? <ComposerStashNotice hasStash={stash !== undefined} /> : null}
      {fullscreen ? (
        <Box maxHeight={isCompact ? Math.floor(compactTransientRows / 2) : undefined} overflow="hidden">
          <Notifications
            compact={isCompact}
            apiKeyStatus={apiKeyStatus}
            debug={debug}
            verbose={verbose}
            messages={messages}
            mcpClients={mcpClients}
            isInputWrapped={input.includes('\n')}
            alignStart
          />
        </Box>
      ) : null}
      <ComposerFooter
        compact={isCompact}
        maxRows={isCompact ? (helpOpen ? Math.max(2, (compactBudget?.editorPoolRows ?? 2) - 1) : compactBudget?.noticeRows ?? 0) : undefined}
        suggestionRows={isCompact ? compactSuggestionRows : undefined}
        suggestions={typeahead.suggestions}
        suggestionType={typeahead.suggestionType}
        onSuggestionPick={typeahead.acceptSuggestionAt}
        onSuggestionHover={typeahead.hoverSuggestionAt}
        helpOpen={helpOpen}
        input={input}
        mode={mode}
        isLoading={isLoading}
        exitPending={exitState.pending}
        exitKeyName={exitState.keyName}
        isPasting={isPasting}
        searchField={searchField}
        isSearching={isSearchingHistory}
        vimInsert={vimEnabled && vimMode === 'INSERT'}
        apiKeyStatus={apiKeyStatus}
        debug={debug}
        verbose={verbose}
        messages={messages}
        mcpClients={mcpClients}
        crewmateFooterIndex={crewmateFooterIndex}
        onOpenTasksDialog={() => setOverlay('tasks-dialog')}
      />
    </Box>
  )
}
