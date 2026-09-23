import type { LocalCommandResult } from '../../types/command.js'
import { isSessionsBarOn, setSessionsBar } from '../../utils/cockpit/sessionsBar.js'

export async function call(args: string): Promise<LocalCommandResult> {
  const want = args.trim().toLowerCase()
  const on = isSessionsBarOn()
  if (want !== 'on' && want !== 'off') {
    return { type: 'text', value: on ? 'SESSIONS bar on — /view off hides it' : 'SESSIONS bar off — /view on shows it' }
  }
  const next = want === 'on'
  if (next === on) return { type: 'text', value: `SESSIONS bar already ${want}` }
  setSessionsBar(next)
  return { type: 'text', value: next ? 'SESSIONS bar on — along the bottom of the chat, kept across resizes and boots' : 'SESSIONS bar off — its rows go to the chat, kept across resizes and boots' }
}
