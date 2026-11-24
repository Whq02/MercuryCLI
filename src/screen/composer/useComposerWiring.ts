import { usePublish } from '../effects/effects.js'
import { usePromptSuggestion } from './usePromptSuggestion.js'
import type { ComposerProps } from './Composer.js'
import { useComposerAttachments } from './useComposerAttachments.js'
import { useComposerCrewmateRefs } from './useComposerCrewmateRefs.js'
import { useComposerModelDoors } from './useComposerModelDoors.js'
import type { useComposerState } from './useComposerState.js'
import { useComposerSuggestions } from './useComposerSuggestions.js'

type ComposerState = ReturnType<typeof useComposerState>
type ComposerModelDoors = ReturnType<typeof useComposerModelDoors>
type ComposerCrewmateRefs = ReturnType<typeof useComposerCrewmateRefs>
type ComposerAttachments = ReturnType<typeof useComposerAttachments>
type ComposerSuggestions = ReturnType<typeof useComposerSuggestions>

export function useComposerWiring({
  overlay,
  setOverlay,
  messages,
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
  isLoading,
  insertTextRef,
  modalOverlayUp,
}: Pick<ComposerState, 'overlay' | 'setOverlay' | 'messages' | 'engineModel' | 'engineModelForSession' | 'focusedMainModel' | 'focusedEffectiveModel' | 'isCompact' | 'columns' | 'appStateStore' | 'setAppState' | 'addNotification' | 'viewedTask' | 'input' | 'mode' | 'cursorOffset' | 'draft' | 'pastedContents' | 'buffer' | 'rows' | 'inputSelectionRangeRef' | 'writeDraft' | 'setCursorOffset' | 'setMode' | 'setPastedContents' | 'deferredSpaceArmedRef'>
  & Pick<ComposerProps, 'isLoading' | 'insertTextRef'>
  & { modalOverlayUp: boolean }): {
  doors: ComposerModelDoors
  capLaneLine: ComposerModelDoors['capLaneLine']
  capLaneCut: ComposerModelDoors['capLaneCut']
  composerCrewmateRef: ComposerCrewmateRefs['composerCrewmateRef']
  viewedCrewmateRef: ComposerCrewmateRefs['viewedCrewmateRef']
  commandCrewmateRef: ComposerCrewmateRefs['commandCrewmateRef']
  viewedAgentName: ComposerCrewmateRefs['viewedAgentName']
  suggestionApi: ReturnType<typeof usePromptSuggestion>
  insertAtCursor: ComposerAttachments['insertAtCursor']
  insertAtomic: ComposerAttachments['insertAtomic']
  handleImagePaste: ComposerAttachments['handleImagePaste']
  handleImageError: ComposerAttachments['handleImageError']
  handleTextPaste: ComposerAttachments['handleTextPaste']
  cursorRef: ComposerAttachments['cursorRef']
  suggestionsState: ComposerSuggestions['suggestionsState']
  setSuggestionsState: ComposerSuggestions['setSuggestionsState']
  suggestionsMirrorRef: ComposerSuggestions['suggestionsMirrorRef']
} {
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

  const {
    composerCrewmateRef,
    viewedCrewmateRef,
    commandCrewmateRef,
    viewedAgentName,
  } = useComposerCrewmateRefs(viewedTask)

  const suggestionApi = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  })
  const { suggestion, markShown } = suggestionApi
  usePublish(() => {
    if (suggestion !== null && mode === 'prompt' && !viewedAgentName) {
      markShown()
    }
  }, [suggestion, mode, viewedAgentName, markShown])

  const {
    insertAtCursor,
    insertAtomic,
    handleImagePaste,
    handleImageError,
    handleTextPaste,
    cursorRef,
  } = useComposerAttachments({
    input,
    cursorOffset,
    pastedContents,
    readLiveState: draft.readLiveState,
    messages,
    rows,
    buffer,
    inputSelectionRangeRef,
    writeDraft,
    setCursorOffset,
    setMode,
    setPastedContents,
    addNotification,
    deferredSpaceArmedRef,
    insertTextRef,
  })

  const {
    suggestionsState,
    setSuggestionsState,
    suggestionsMirrorRef,
  } = useComposerSuggestions()

  return {
    doors,
    capLaneLine: doors.capLaneLine,
    capLaneCut: doors.capLaneCut,
    composerCrewmateRef,
    viewedCrewmateRef,
    commandCrewmateRef,
    viewedAgentName,
    suggestionApi,
    insertAtCursor,
    insertAtomic,
    handleImagePaste,
    handleImageError,
    handleTextPaste,
    cursorRef,
    suggestionsState,
    setSuggestionsState,
    suggestionsMirrorRef,
  }
}
