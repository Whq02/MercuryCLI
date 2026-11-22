import { useMemo } from 'react'
import { usePublish } from '../../hooks/effects.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getExampleCommandFromCache } from '../../utils/exampleCommands.js'
import { noteProjectOnboardingShown, projectOnboardingHint } from '../../projectOnboardingState.js'
import { truncateToWidth } from '../../utils/glyphs.js'
import { crewmatePlaceholder } from '../../utils/cockpit/crewmateWords.js'
import { notBuilt } from '../../pi/holes.js'

export function usePromptInputPlaceholder(arg0: {
  input: string
  submitCount: number
  viewingAgentName?: string
  cockpitActive?: boolean
  compact?: boolean
}): string | undefined {
  return notBuilt('src/components/PromptInput/usePromptInputPlaceholder.ts:13')
}
