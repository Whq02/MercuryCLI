import type { UUID } from 'node:crypto'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { getTranscriptPath, saveAgentName, saveCustomTitle } from '../../utils/sessionStorage.js'
import { isCompactBoundaryMessage } from '../../utils/messages.js'
import { getTeammateContext } from '../../utils/teammate.js'
import { generateSessionName } from './generateSessionName.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<null> {
  if (getTeammateContext() !== undefined) {
    onDone('This session cannot be renamed — teammate names are set by the team leader.', {
      display: 'system',
    })
    return null
  }

  let name = (args ?? '').trim()
  if (name === '') {
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

  if (hasFocusedSession()) {
    const sessionId = getFocusedSessionConnector().sessionId()
    try {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const reply = (await daemonControlRpc(
        { op: 'sessionControl', action: 'set-title', sessionId, by: 'operator', title: name, titleSource: 'operator' } as never,
        { timeoutMs: 10_000 },
      )) as { ok?: boolean; outcome?: string; detail?: string }
      if (reply.ok !== true || reply.outcome !== 'applied') {
        onDone(`The session was not renamed — ${reply.detail ?? 'the daemon refused it'}`, { display: 'system' })
        return null
      }
    } catch {
      onDone('The session was not renamed — the daemon that hosts sessions was unreachable.', { display: 'system' })
      return null
    }
    context.setAppState(prev => ({
      ...prev,
      standaloneAgentContext: { ...prev.standaloneAgentContext, name },
    }))
    onDone(`Renamed this session to ${name}`, { display: 'system' })
    return null
  }

  const sessionId = getSessionId() as UUID
  const transcriptPath = getTranscriptPath()
  await saveCustomTitle(sessionId, name, transcriptPath)
  await saveAgentName(sessionId, name, transcriptPath)
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: { ...prev.standaloneAgentContext, name },
  }))
  onDone(`Renamed this session to ${name}`, { display: 'system' })
  return null
}
