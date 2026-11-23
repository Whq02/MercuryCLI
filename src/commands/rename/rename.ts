import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { getTranscriptPath, saveAgentName, saveCustomTitle } from '../../utils/sessionStorage.js'
import { isCompactBoundaryMessage } from '../../services/messages.js'
import { generateSessionName } from './generateSessionName.js'
import { partiallySanitizeUnicode } from '../../utils/sanitization.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<null> {
  const focusedSessionId = hasFocusedSession() ? getFocusedSessionConnector().sessionId() : ''
  let rawName = (args ?? '').trim()
  if (rawName === '') {
    const messages = context.messages ?? []
    let startIdx = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg !== undefined && isCompactBoundaryMessage(msg)) {
        startIdx = i + 1
        break
      }
    }
    const recentMessages = startIdx > 0 ? messages.slice(startIdx) : messages
    let generated: string | null
    try {
      generated = await generateSessionName(recentMessages, context.abortController.signal)
    } catch (thrown) {
      const reason = thrown instanceof Error ? thrown.message : String(thrown)
      onDone(`Could not generate a session name (${reason}). Use /rename <name> to name the session directly.`, { display: 'system' })
      return null
    }
    if (generated === null || generated.trim() === '') {
      onDone('No conversation context yet — use /rename <name> to name the session directly.', { display: 'system' })
      return null
    }
    rawName = generated
  }

  const name = partiallySanitizeUnicode(rawName).trim()
  if (name === '') {
    onDone('A session name needs visible text.', { display: 'system' })
    return null
  }

  if (focusedSessionId !== '') {
    try {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'sessionControl', action: 'set-title', sessionId: focusedSessionId, by: 'operator', title: name, titleSource: 'operator' },
        { timeoutMs: 10_000 },
      )
      if (reply.ok && reply.op === 'sessionControl' && reply.outcome === 'applied') {
        if (hasFocusedSession() && getFocusedSessionConnector().sessionId() === focusedSessionId) {
          context.setAppState(prev => ({
            ...prev,
            standaloneAgentContext: {
              ...prev.standaloneAgentContext,
              name,
            },
          }))
        }
        onDone(`Renamed this session to ${name}`, { display: 'system' })
      } else {
        const reason = !reply.ok
          ? reply.error
          : reply.op === 'sessionControl' && reply.detail
            ? reply.detail
            : 'the daemon refused it'
        onDone(`Could not rename this session — ${reason}`, { display: 'system' })
      }
    } catch {
      onDone('Could not rename this session — the daemon that hosts sessions was unreachable.', { display: 'system' })
    }
    return null
  }

  const sessionId = getSessionId()
  const fullPath = getTranscriptPath()
  await saveCustomTitle(sessionId, name, fullPath, 'user')
  await saveAgentName(sessionId, name, fullPath, 'user')
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name,
    },
  }))
  onDone(`Renamed this session to ${name}`, { display: 'system' })
  return null
}
