import { useMemo } from 'react'
import { usePublish } from '../../hooks/effects.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getExampleCommandFromCache } from '../../utils/exampleCommands.js'
import { noteProjectOnboardingShown, projectOnboardingHint } from '../../projectOnboardingState.js'
import { truncateToWidth } from '../../utils/glyphs.js'
import { crewmatePlaceholder } from '../../utils/cockpit/crewmateWords.js'

const AGENT_NAME_MAX_COLUMNS = 24

export function usePromptInputPlaceholder({
  input,
  submitCount,
  viewingAgentName,
  cockpitActive,
  compact = false,
}: {
  input: string
  submitCount: number
  viewingAgentName?: string
  cockpitActive?: boolean
  compact?: boolean
}): string | undefined {
  const promptSuggestionEnabled = useAppState(
    (s: AppState) => s.promptSuggestionEnabled,
  )
  const isInputEmpty = input === ''
  const onboardingHint = useMemo(() => {
    if (!isInputEmpty || submitCount !== 0 || viewingAgentName) {
      return undefined
    }
    return projectOnboardingHint()
  }, [isInputEmpty, submitCount, viewingAgentName])

  usePublish(() => {
    if (onboardingHint) {
      noteProjectOnboardingShown()
    }
  }, [onboardingHint])

  if (!isInputEmpty) return undefined
  if (viewingAgentName) {
    return crewmatePlaceholder(
      truncateToWidth(viewingAgentName, AGENT_NAME_MAX_COLUMNS),
    )
  }
  if (onboardingHint) return onboardingHint
  if (submitCount < 2) {
    if (compact) {
      return 'Type a prompt, or start a slash command'
    }
    if (cockpitActive) {
      return 'Type a prompt, start a slash command, or Tab to focus the rails'
    }
  }
  if (submitCount === 0 && promptSuggestionEnabled) {
    return getExampleCommandFromCache()
  }
  return undefined
}
