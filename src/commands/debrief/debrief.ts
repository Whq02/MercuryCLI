import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { generateAwaySummary } from '../../services/awaySummary.js'

// ============================================================================
// commands/debrief/debrief.ts — the /debrief handler.
// ----------------------------------------------------------------------------
// Asks the session-summary service for a short "where we left off" line over
// the current transcript, honoring the run's abort signal. The service
// returns string | null and folds its failure classes (abort, API error,
// generation failure) into null before we see them — so the handler has two
// fallbacks: specific copy for an empty transcript (checked first, so the
// user gets the actionable answer), generic copy for everything else.
// ============================================================================

export const call = async (
  _args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  if (context.messages.length === 0) {
    return {
      type: 'text',
      value: 'Nothing to debrief yet — send a message first.',
    }
  }

  const debrief = await generateAwaySummary(
    context.messages,
    context.abortController.signal,
  )

  if (debrief === null || debrief.trim() === '') {
    return {
      type: 'text',
      value: "Couldn't generate a debrief. Run with --debug for details.",
    }
  }

  return { type: 'text', value: debrief }
}
