import type { LocalCommandCall } from '../catalogue/command.js'
import { clearFocusedSession } from '../../daemon/switchboard/hopIntoSession.js'

export const call: LocalCommandCall = async () => {
  const outcome = await clearFocusedSession()
  if (!outcome.ok) return { type: 'text', value: outcome.reason }
  return { type: 'skip' }
}
