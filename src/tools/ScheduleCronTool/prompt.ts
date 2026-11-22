import { getIsSessionOneShotHeadless } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export const CRON_CREATE_TOOL_NAME: Unbuilt = unbuilt('src/tools/ScheduleCronTool/prompt.ts:6')
export const CRON_DELETE_TOOL_NAME: Unbuilt = unbuilt('src/tools/ScheduleCronTool/prompt.ts:7')
export const CRON_LIST_TOOL_NAME: Unbuilt = unbuilt('src/tools/ScheduleCronTool/prompt.ts:8')

export const SATURN_BOARD_COMMAND: Unbuilt = unbuilt('src/tools/ScheduleCronTool/prompt.ts:10')

export function isSaturnSchedulingEnabled(): boolean {
  return notBuilt('src/tools/ScheduleCronTool/prompt.ts:12')
}

export function cronToolsMountable(): boolean {
  if (!isSaturnSchedulingEnabled()) return false
  return !getIsSessionOneShotHeadless()
}

export function buildCronCreateDescription(): string {
  return "Put a prompt on this session's clock: once after a delay or at a set time, or repeating on a cron expression (local time). The daemon keeps it on the session's record, fires it (even into a parked session), and receipts every fire."
}

export function buildCronCreatePrompt(): string {
  return `Schedules a prompt on this session's daemon record (visible on ${SATURN_BOARD_COMMAND}), firing on this session's model and account even when parked. It returns the schedule's id and its fire time in local time and UTC; non-"Scheduled" replies state whether it may have landed and how to check. Fires land within 30s only while the session is idle; a schedule outlives interrupts, holds with a receipt until /logins if sign-in cannot serve it, and runs late after machine sleep (or records missed past the catch-up window).`
}

export const CRON_DELETE_DESCRIPTION = "Take a schedule off this session's clock, by id."

export function buildCronDeletePrompt(): string {
  return `Cancels a schedule on this session's record by id; the removal travels on the session's next facts beat and is receipted.`
}

export const CRON_LIST_DESCRIPTION = "List this session's schedules."

export function buildCronListPrompt(): string {
  return `Lists this session's schedules as the daemon last pushed them: id, timing, one-shot or recurring, fire-into-session or session-birth, next fire, paused state. A schedule answered "Queued, not confirmed" at creation appears once the daemon applies it.`
}
