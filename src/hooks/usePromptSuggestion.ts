import { notBuilt } from '../pi/holes.js'

export function usePromptSuggestion(arg0: {
  inputValue: string
  isAssistantResponding: boolean
}): {
  suggestion: string | null
  markAccepted: () => void
  markShown: () => void
  logOutcomeAtSubmission: (finalInput: string, opts?: { skipReset: boolean }) => void
} {
  return notBuilt('src/hooks/usePromptSuggestion.ts:20')
}
