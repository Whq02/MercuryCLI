import { useCallback } from 'react'
import { abortSpeculation, clearPromptSuggestion } from '../prompt-suggestion/speculation.js'
import { useAppState, useSetAppState, type AppState } from '../app-state/AppState.js'

type StampField = 'shownAt' | 'acceptedAt'
type PromptSuggestionRecord = AppState['promptSuggestion']

const STAMP_ADMITS: Record<StampField, (current: PromptSuggestionRecord) => boolean> = {
  shownAt: current => current.text !== null && current.shownAt === 0,
  acceptedAt: current => current.text !== null && current.shownAt > 0,
}

export function usePromptSuggestion({
  inputValue,
  isAssistantResponding,
}: {
  inputValue: string
  isAssistantResponding: boolean
}): {
  suggestion: string | null
  markAccepted: () => void
  markShown: () => void
  logOutcomeAtSubmission: (finalInput: string, opts?: { skipReset: boolean }) => void
} {
  const suggestionText = useAppState(s => s.promptSuggestion.text)
  const setAppState = useSetAppState()

  const suggestion = isAssistantResponding || inputValue !== '' ? null : suggestionText

  const stamp = useCallback(
    (field: StampField) => {
      setAppState(prev => {
        if (!STAMP_ADMITS[field](prev.promptSuggestion)) return prev
        return {
          ...prev,
          promptSuggestion: {
            ...prev.promptSuggestion,
            [field]: Date.now(),
          },
        }
      })
    },
    [setAppState],
  )

  const markShown = useCallback(() => {
    stamp('shownAt')
  }, [stamp])

  const markAccepted = useCallback(() => {
    stamp('acceptedAt')
  }, [stamp])

  const logOutcomeAtSubmission = useCallback(
    (_finalInput: string, opts?: { skipReset: boolean }) => {
      if (opts?.skipReset === true) return
      abortSpeculation(setAppState)
      setAppState(clearPromptSuggestion)
    },
    [setAppState],
  )

  return {
    suggestion,
    markAccepted,
    markShown,
    logOutcomeAtSubmission,
  }
}
