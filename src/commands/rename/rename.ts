import type { UUID } from 'node:crypto'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getTranscriptPath, saveAgentName, saveCustomTitle } from '../../utils/sessionStorage.js'
import { isCompactBoundaryMessage } from '../../utils/messages.js'
import { getTeammateContext } from '../../utils/teammate.js'
import { generateSessionName } from './generateSessionName.js'

/**
 * `/rename` — name the session, generating a name when none is given.
 * Always resolves to a null node.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<null> {
  // Teammate refusal: teammate names are set by the team leader.
  if (getTeammateContext() !== null) {
    onDone('This session cannot be renamed — teammate names are set by the team leader.', {
      display: 'system',
    })
    return null
  }

  let name = (args ?? '').trim()
  if (name === '') {
    // Generate from the messages after the compaction boundary.
    const messages = context.messages ?? []
    const lastBoundary = messages.reduce(
      (found, message, index) => (isCompactBoundaryMessage(message) ? index : found),
      -1,
    )
    const generated = await generateSessionName(
      messages.slice(lastBoundary + 1),
      context.abortController.signal,
    )
    if (generated === null) {
      onDone(
        'No conversation context to generate a name from yet. Use /rename <name> to name the session directly.',
        { display: 'system' },
      )
      return null
    }
    name = generated
  }

  const sessionId = getSessionId() as UUID
  const transcriptPath = getTranscriptPath()
  // Persisted twice: the custom title, and the agent name the prompt bar
  // displays.
  await saveCustomTitle(sessionId, name, transcriptPath)
  await saveAgentName(sessionId, name, transcriptPath)
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: { ...prev.standaloneAgentContext, name },
  }))
  onDone(`Renamed this session to ${name}`, { display: 'system' })
  return null
}
