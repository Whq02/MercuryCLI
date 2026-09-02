// The idle placeholder: rungs in priority order — viewed agent, the
// project first-run step before any submission, cockpit rail
// discoverability before the second submission, then a cached example
// command when prompt suggestions are enabled and no proactive mode
// drives. Only when the input is empty. (The steer/queue rungs died with
// the operator-facing pen — a sent message is simply sent, so the empty
// composer promises nothing about holding.)

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
  // FC-134: the per-project first-run hint — composed and gated by
  // projectOnboardingState but never consumed by anything. It rides the
  // idle placeholder before any submission; the persisted seen count bumps
  // once per session on the first paint (the effect, never the render).
  // (The pre-fold gate also excluded a running turn via isLoading; that
  // prop died with the steer/queue rungs, and submitCount === 0 already
  // bounds the rung to the pre-first-submission composer.)
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
    // 1 · viewing an agent — the name truncates by DISPLAY width
    // (grapheme-safe); code-unit truncation splits surrogates.
    if (viewingAgentName) {
      return `Message ${truncateToWidth(viewingAgentName, AGENT_NAME_MAX_COLUMNS)}…`
    }
    // 2 · the project first-run step (FC-134) — more specific than the
    // generic discoverability line, so it leads while it applies.
    if (onboardingHint !== undefined) {
      return onboardingHint
    }
    // 3 · cockpit discoverability before the second submission.
    if (cockpitActive && submitCount < 2) {
      return 'Type a prompt, start a slash command, or Tab to focus the rails'
    }
    // 4 · a cached example command.
    if (submitCount === 0 && suggestionsEnabled) {
      return getExampleCommandFromCache()
    }
    return undefined
  }, [input, viewingAgentName, cockpitActive, submitCount, suggestionsEnabled, onboardingHint])
}
