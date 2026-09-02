
import { useCallback } from 'react'
import { useAppState, useSetAppState, type AppState } from '../state/AppState.js'
import { abortSpeculation } from '../services/PromptSuggestion/speculation.js'

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
  logOutcomeAtSubmission: (
    finalInput: string,
    opts?: { skipReset: boolean },
  ) => void
} {
  const setAppState = useSetAppState()
  const record = useAppState((state: AppState) => state.promptSuggestion)

  const suggestion =
    isAssistantResponding || inputValue !== ''
      ? null
      : (record?.text ?? null)

  const markAccepted = useCallback((): void => {
    setAppState(prev => {
      const current = prev.promptSuggestion
      if (current.text === null || current.shownAt <= 0) return prev
      return {
        ...prev,
        promptSuggestion: { ...current, acceptedAt: Date.now() },
      }
    })
  }, [setAppState])

  const markShown = useCallback((): void => {
    setAppState(prev => {
      const current = prev.promptSuggestion
      if (current.text === null || current.shownAt > 0) return prev
      return {
        ...prev,
        promptSuggestion: { ...current, shownAt: Date.now() },
      }
    })
  }, [setAppState])

  const reset = useCallback((): void => {
    abortSpeculation(setAppState)
    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }))
  }, [setAppState])

  const logOutcomeAtSubmission = useCallback(
    (finalInput: string, opts?: { skipReset: boolean }): void => {
      setAppState(prev => {
        const current = prev.promptSuggestion
        const accepted =
          current.shownAt > 0 &&
          ((current.acceptedAt > 0 && current.acceptedAt >= current.shownAt) ||
            finalInput === current.text)
        void accepted
        return prev
      })
      if (opts?.skipReset !== true) reset()
    },
    [reset, setAppState],
  )

  return { suggestion, markAccepted, markShown, logOutcomeAtSubmission }
}
