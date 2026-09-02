import type { LocalCommandCall } from '../../types/command.js'
import { clearFocusedSession } from '../../services/switchboard/hopIntoSession.js'

/** /clear acts on the SCREEN's focused chat: the session is dropped (stopped
 *  and released — its transcript survives for /resume) and a fresh blank
 *  chat takes its place; a blank chat is already fresh. Mid-turn the
 *  refusal names the one action that unblocks it. */
export const call: LocalCommandCall = async () => {
  const outcome = await clearFocusedSession()
  if (!outcome.ok) return { type: 'text', value: outcome.reason }
  return { type: 'skip' }
}
