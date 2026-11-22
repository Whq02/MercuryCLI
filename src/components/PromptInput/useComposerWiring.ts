import { usePublish } from '../../hooks/effects.js'
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import type { PromptInputProps } from './PromptInput.js'
import { useComposerAttachments } from './useComposerAttachments.js'
import { useComposerCrewmateRefs } from './useComposerCrewmateRefs.js'
import { useComposerModelDoors } from './useComposerModelDoors.js'
import type { useComposerState } from './useComposerState.js'
import { useComposerSuggestions } from './useComposerSuggestions.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ComposerState = ReturnType<typeof useComposerState>

export function useComposerWiring(arg0: Pick<ComposerState, 'overlay' | 'setOverlay' | 'messages' | 'engineModel' | 'engineModelForSession' | 'focusedMainModel' | 'focusedEffectiveModel' | 'isCompact' | 'columns' | 'appStateStore' | 'setAppState' | 'addNotification' | 'viewedTask' | 'input' | 'mode' | 'cursorOffset' | 'draft' | 'pastedContents' | 'buffer' | 'rows' | 'inputSelectionRangeRef' | 'writeDraft' | 'setCursorOffset' | 'setMode' | 'setPastedContents' | 'deferredSpaceArmedRef'>
  & Pick<PromptInputProps, 'isLoading' | 'insertTextRef'>
  & { modalOverlayUp: boolean }): Unbuilt {
  return notBuilt('src/components/PromptInput/useComposerWiring.ts:12')
}
