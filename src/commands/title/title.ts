import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../catalogue/command.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../engine/connector/focusedConnector.js'
import { extractConversationText, generateSessionTitle } from '../../screen/concourse-model/sessionTitle.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<null> {
  if (!hasFocusedSession()) {
    onDone('No chat is open — /title names the focused session.', { display: 'system' })
    return null
  }
  const sessionId = getFocusedSessionConnector().sessionId()
  let title = (args ?? '').trim()
  if (title === '') {
    const generated = await generateSessionTitle(
      extractConversationText(context.messages ?? []),
      context.abortController.signal,
    )
    if (generated === null) {
      onDone('No conversation to title yet — say something first, or use /title <words>.', { display: 'system' })
      return null
    }
    title = generated
  }
  try {
    const { daemonControlRpc } = await import('../../daemon/control/controlSocket.js')
    const reply = await daemonControlRpc(
      { op: 'sessionControl', action: 'set-title', sessionId, by: 'operator', title, titleSource: 'operator' },
      { timeoutMs: 10_000 },
    )
    if (reply.ok === true && reply.outcome === 'applied') {
      onDone(`Titled this session "${title}"`, { display: 'system' })
    } else {
      onDone(`The title was not set — ${(reply.ok ? reply.detail : undefined) ?? 'the daemon refused it'}`, { display: 'system' })
    }
  } catch {
    onDone('The title was not set — the daemon that hosts sessions was unreachable.', { display: 'system' })
  }
  return null
}
