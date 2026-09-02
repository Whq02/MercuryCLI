import type { LocalCommandCall } from '../../types/command.js'
import { clearFocusedSession } from '../../services/switchboard/hopIntoSession.js'

export const call: LocalCommandCall = async () => {
  const outcome = await clearFocusedSession()
  if (!outcome.ok) return { type: 'text', value: outcome.reason }
  return { type: 'skip' }
}
