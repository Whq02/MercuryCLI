// The speculative prompt suggestion: suppressed while the
// assistant responds or the input is non-empty; markShown is checked
// INSIDE the updater (depending on the stamp loops); the outcome
// recorder's acceptance verdict has NO observable effect in this build —
// the emit site is absent; keep the shape, keep it inert.
//
// The record is the DECLARED AppState member: shownAt/acceptedAt are
// numbers with 0 as the not-yet sentinel.

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
      // Only a valid suggestion (text present and already shown) accepts.
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
      // Checked inside the updater; a no-op when already stamped or empty.
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
      // The acceptance determination is computed and deliberately unused —
      // the emit site is absent; the reset is the only visible act.
      // It reads the record inside a pass-through updater so the freshest
      // stamps are consulted without a snapshot escape hatch.
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
