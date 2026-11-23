import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../ComposerFooterSuggestions.js'

export type SuggestionsState = {
  suggestions: Suggestion[]
  selectedSuggestion: number
  commandArgumentHint?: string
}

export type Publish = (
  next: Suggestion[],
  type: SuggestionType,
  opts?: { selected?: number; maxWidth?: number; argumentHint?: string },
) => void
