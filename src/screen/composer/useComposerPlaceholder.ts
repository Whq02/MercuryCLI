import { useMemo } from 'react'
import { usePublish } from '../effects/effects.js'
import { useAppState } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppStateStore.js'
import { getExampleCommandFromCache } from './exampleCommands.js'
import { noteProjectOnboardingShown, projectOnboardingHint } from '../../boot/projectOnboarding.js'
import { truncateToWidth } from '../theme/glyphs.js'
import { crewmatePlaceholder } from '../cockpit/crewmateWords.js'

const CREWMATE_NAME_MAX_COLUMNS = 24

export function useComposerPlaceholder({
  input,
  submitCount,
  viewingCrewmateName,
  cockpitActive,
  compact = false,
}: {
  input: string
  submitCount: number
  viewingCrewmateName?: string
  cockpitActive?: boolean
  compact?: boolean
}): string | undefined {
  const promptSuggestionEnabled = useAppState(
    (s: AppState) => s.promptSuggestionEnabled,
  )
  const isInputEmpty = input === ''
  const onboardingHint = useMemo(() => {
    if (!isInputEmpty || submitCount !== 0 || viewingCrewmateName) {
      return undefined
    }
    return projectOnboardingHint()
  }, [isInputEmpty, submitCount, viewingCrewmateName])

  usePublish(() => {
    if (onboardingHint) {
      noteProjectOnboardingShown()
    }
  }, [onboardingHint])

  if (!isInputEmpty) return undefined
  if (viewingCrewmateName) {
    return crewmatePlaceholder(
      truncateToWidth(viewingCrewmateName, CREWMATE_NAME_MAX_COLUMNS),
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
