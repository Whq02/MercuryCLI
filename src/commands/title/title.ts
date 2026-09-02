import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { extractConversationText, generateSessionTitle } from '../../utils/sessionTitle.js'

/**
 * `/title` — name the FOCUSED session (session-aware naming, stage 3's
 * editable half): the words become the session's stored title through the
 * daemon's set-title door, source 'operator' — a typed name outranks and
 * outlives the one-time model mint (the mint fills empty titles only). With
 * no words, the model writes one from this chat (the same small call the
 * mint rides — explicit, so the spend is the operator's own ask). The board
 * row, the tag and the hop all read the stored title through the one naming
 * owner. `/rename` stays the log-side name; this titles the session record.
 */
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
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const reply = (await daemonControlRpc(
      { op: 'sessionControl', action: 'set-title', sessionId, by: 'operator', title, titleSource: 'operator' } as never,
      { timeoutMs: 10_000 },
    )) as { ok?: boolean; outcome?: string; detail?: string }
    if (reply.ok === true && reply.outcome === 'applied') {
      onDone(`Titled this session "${title}"`, { display: 'system' })
    } else {
      onDone(`The title was not set — ${reply.detail ?? 'the daemon refused it'}`, { display: 'system' })
    }
  } catch {
    onDone('The title was not set — the daemon that hosts sessions was unreachable.', { display: 'system' })
  }
  return null
}
