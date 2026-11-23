import { useCallback, useRef, useState } from 'react'
import type { SuggestionsState } from './typeahead/useTypeahead.js'
import { setSelectedSuggestionStore } from './suggestionSelectionStore.js'

export function useComposerSuggestions() {
  const [suggestionsState, setSuggestionsStateRaw] = useState<SuggestionsState>({
    suggestions: [],
    selectedSuggestion: 0,
  })
  const suggestionsMirrorRef = useRef(suggestionsState)
  const setSuggestionsState = useCallback(
    (
      update:
        | SuggestionsState
        | ((prev: SuggestionsState) => SuggestionsState),
    ): void => {
      const previous = suggestionsMirrorRef.current
      const next =
        typeof update === 'function' ? update(previous) : update
      setSelectedSuggestionStore(next.selectedSuggestion)
      if (
        next.suggestions !== previous.suggestions ||
        next.commandArgumentHint !== previous.commandArgumentHint
      ) {
        suggestionsMirrorRef.current = next
        setSuggestionsStateRaw(next)
      } else {
        suggestionsMirrorRef.current = {
          ...previous,
          selectedSuggestion: next.selectedSuggestion,
        }
      }
    },
    [],
  )
  return { suggestionsState, setSuggestionsState, suggestionsMirrorRef }
}
