import type { UUID } from 'node:crypto'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../catalogue/command.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../engine/connector/focusedConnector.js'
import { getTranscriptPath, saveAgentName, saveCustomTitle } from '../../sessions/transcripts/sessionStorage.js'
import { isFoldBoundaryMessage } from '../../engine/messages/messages.js'
import { generateSessionName } from './generateSessionName.js'
import { partiallySanitizeUnicode } from '../../platform/text/unicodeSanitization.js'

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
      if (msg !== undefined && isFoldBoundaryMessage(msg)) {
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
      onDone('No conversation context to generate a name from yet. Use /rename <name> to name the session directly.', { display: 'system' })
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
      const { daemonControlRpc } = await import('../../daemon/control/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'sessionControl', action: 'set-title', sessionId: focusedSessionId, by: 'operator', title: name, titleSource: 'operator' },
        { timeoutMs: 10_000 },
      )
      if (reply.ok && reply.outcome === 'applied') {
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
        const reason = (reply.ok ? reply.detail : undefined) ?? 'the daemon refused it'
        onDone(`The session was not renamed — ${reason}`, { display: 'system' })
      }
    } catch {
      onDone('The session was not renamed — the daemon that hosts sessions was unreachable.', { display: 'system' })
    }
    return null
  }

  const sessionId: UUID = getSessionId()
  const fullPath = getTranscriptPath()
  await saveCustomTitle(sessionId, name, fullPath)
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
