import { useCallback } from 'react'
import { abortSpeculation, clearPromptSuggestion } from '../services/PromptSuggestion/speculation.js'
import { useAppState, useSetAppState, type AppState } from '../state/AppState.js'

type SuggestionRecord = AppState['promptSuggestion']

type Stamp = 'shownAt' | 'acceptedAt'

const STAMP_ADMITS: Record<Stamp, (record: SuggestionRecord) => boolean> = {
  shownAt: record => record.text !== null && record.shownAt === 0,
  acceptedAt: record => record.text !== null && record.shownAt > 0,
}

function stamped(prev: AppState, stamp: Stamp): AppState {
  const record = prev.promptSuggestion
  if (!STAMP_ADMITS[stamp](record)) return prev
  return { ...prev, promptSuggestion: { ...record, [stamp]: Date.now() } }
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
  const setAppState = useSetAppState()
  const text = useAppState(state => state.promptSuggestion.text)
  const suppressed = isAssistantResponding || inputValue !== ''

  const markShown = useCallback(() => setAppState(prev => stamped(prev, 'shownAt')), [setAppState])
  const markAccepted = useCallback(() => setAppState(prev => stamped(prev, 'acceptedAt')), [setAppState])

  const logOutcomeAtSubmission = useCallback(
    (_finalInput: string, opts?: { skipReset: boolean }) => {
      if (opts?.skipReset === true) return
      abortSpeculation(setAppState)
      setAppState(clearPromptSuggestion)
    },
    [setAppState],
  )

  return { suggestion: suppressed ? null : text, markAccepted, markShown, logOutcomeAtSubmission }
}
