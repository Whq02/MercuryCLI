import { usePublish } from '../../hooks/effects.js'
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import type { PromptInputProps } from './PromptInput.js'
import { useComposerAttachments } from './useComposerAttachments.js'
import { useComposerCrewmateRefs } from './useComposerCrewmateRefs.js'
import { useComposerModelDoors } from './useComposerModelDoors.js'
import type { useComposerState } from './useComposerState.js'
import { useComposerSuggestions } from './useComposerSuggestions.js'

type ComposerState = ReturnType<typeof useComposerState>

export function useComposerWiring({
  overlay,
  setOverlay,
  messages,
  modalOverlayUp,
  engineModel,
  engineModelForSession,
  focusedMainModel,
  focusedEffectiveModel,
  isCompact,
  columns,
  appStateStore,
  setAppState,
  addNotification,
  viewedTask,
  input,
  isLoading,
  mode,
  cursorOffset,
  draft,
  pastedContents,
  buffer,
  rows,
  inputSelectionRangeRef,
  writeDraft,
  setCursorOffset,
  setMode,
  setPastedContents,
  deferredSpaceArmedRef,
  insertTextRef,
}: Pick<ComposerState, 'overlay' | 'setOverlay' | 'messages' | 'engineModel' | 'engineModelForSession' | 'focusedMainModel' | 'focusedEffectiveModel' | 'isCompact' | 'columns' | 'appStateStore' | 'setAppState' | 'addNotification' | 'viewedTask' | 'input' | 'mode' | 'cursorOffset' | 'draft' | 'pastedContents' | 'buffer' | 'rows' | 'inputSelectionRangeRef' | 'writeDraft' | 'setCursorOffset' | 'setMode' | 'setPastedContents' | 'deferredSpaceArmedRef'>
  & Pick<PromptInputProps, 'isLoading' | 'insertTextRef'>
  & { modalOverlayUp: boolean }) {
  const doors = useComposerModelDoors({
    overlay,
    setOverlay,
    messages,
    modalOverlayUp,
    engineModel,
    engineModelForSession,
    focusedMainModel,
    focusedEffectiveModel,
    isCompact,
    columns,
    appStateStore,
    setAppState,
    addNotification,
  })
  const { capLaneLine, capLaneCut } = doors

  const { composerCrewmateRef, viewedCrewmateRef, commandCrewmateRef, viewedAgentName, viewedAgentColor } = useComposerCrewmateRefs(viewedTask)


  const suggestionApi = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  })
  const suggestionDisplayable =
    suggestionApi.suggestion !== null && mode === 'prompt' && !viewedAgentName
  const markSuggestionShown = suggestionApi.markShown
  usePublish(() => {
    if (suggestionDisplayable) markSuggestionShown()
  }, [suggestionDisplayable, markSuggestionShown])

  const attachments = useComposerAttachments({
    input,
    cursorOffset,
    readLiveState: draft.readLiveState,
    pastedContents,
    buffer,
    messages,
    rows,
    inputSelectionRangeRef,
    writeDraft,
    setCursorOffset,
    setMode,
    setPastedContents,
    addNotification,
    deferredSpaceArmedRef,
    insertTextRef,
  })
  const { insertAtCursor, insertAtomic, handleImagePaste, handleImageError, handleTextPaste, cursorRef } = attachments

  const { suggestionsState, setSuggestionsState, suggestionsMirrorRef } = useComposerSuggestions()
  return { doors, capLaneLine, capLaneCut, composerCrewmateRef, viewedCrewmateRef, commandCrewmateRef, viewedAgentName, viewedAgentColor, suggestionApi, insertAtCursor, insertAtomic, handleImagePaste, handleImageError, handleTextPaste, cursorRef, suggestionsState, setSuggestionsState, suggestionsMirrorRef }
}
