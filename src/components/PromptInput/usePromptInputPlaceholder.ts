
import { useEffect, useMemo } from 'react'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getExampleCommandFromCache } from '../../utils/exampleCommands.js'
import { noteProjectOnboardingShown, projectOnboardingHint } from '../../projectOnboardingState.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'

const AGENT_NAME_MAX_COLUMNS = 20

export function usePromptInputPlaceholder({
  input,
  submitCount,
  viewingAgentName,
  cockpitActive,
}: {
  input: string
  submitCount: number
  viewingAgentName?: string
  cockpitActive?: boolean
}): string | undefined {
  const onboardingHint =
    input === '' && submitCount === 0 && !viewingAgentName
      ? projectOnboardingHint()
      : undefined
  useEffect(() => {
    if (onboardingHint !== undefined) noteProjectOnboardingShown()
  }, [onboardingHint])
  const suggestionsEnabled = useAppState(
    (state: AppState) => state.promptSuggestionEnabled,
  )

  return useMemo(() => {
    if (input !== '') return undefined
    if (viewingAgentName) {
      return `Message ${truncateToWidth(viewingAgentName, AGENT_NAME_MAX_COLUMNS)}…`
    }
    if (onboardingHint !== undefined) {
      return onboardingHint
    }
    if (cockpitActive && submitCount < 2) {
      return 'Type a prompt, start a slash command, or Tab to focus the rails'
    }
    if (submitCount === 0 && suggestionsEnabled) {
      return getExampleCommandFromCache()
    }
    return undefined
  }, [input, viewingAgentName, cockpitActive, submitCount, suggestionsEnabled, onboardingHint])
}
