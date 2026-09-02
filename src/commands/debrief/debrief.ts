import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { generateAwaySummary } from '../../services/awaySummary.js'


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
