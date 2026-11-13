import { getIsSessionOneShotHeadless } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'


export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

export const SATURN_BOARD_COMMAND = '/saturn'

export function isSaturnSchedulingEnabled(): boolean {
  return !isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))
}

export function cronToolsMountable(): boolean {
  if (!isSaturnSchedulingEnabled()) return false
  return !getIsSessionOneShotHeadless()
}

export function buildCronCreateDescription(): string {
  return "Put a prompt on this session's clock: once after a delay or at a set time, or repeating on a cron expression (local time). The daemon keeps it on the session's record, fires it (even into a parked session), and receipts every fire."
}

export function buildCronCreatePrompt(): string {
  return `Schedules a prompt on this session's daemon record (visible on ${SATURN_BOARD_COMMAND}), firing on this session's model and account even when parked. Returns schedule id and next fire in local time and UTC; non-"Scheduled" replies state whether it may have landed and how to check. Fires land within 30s once idle, survive interrupts, hold with a receipt until /logins if sign-in cannot serve them, and run late after machine sleep (or record missed past the catch-up window).`
}

export const CRON_DELETE_DESCRIPTION = "Take a schedule off this session's clock, by id."

export function buildCronDeletePrompt(): string {
  return `Cancels a schedule on this session's record by id; the removal travels on the session's next facts beat and is receipted.`
}

export const CRON_LIST_DESCRIPTION = "List this session's schedules."

export function buildCronListPrompt(): string {
  return `Lists this session's schedules as the daemon last pushed them: id, timing, one-shot or recurring, fire-into-session or session-birth, next fire, paused state. A schedule answered "Queued, not confirmed" at creation appears once the daemon applies it.`
}
