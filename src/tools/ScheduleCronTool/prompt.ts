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
  return `Put a prompt on this session's clock: one run after a delay or at a set time, or a repeating cron schedule. The Mercury daemon keeps it on this session's record and fires it, even into a parked session.

## When: exactly one of
- delayMinutes: one run that many minutes from now ("in 20 minutes" → 20); it fires on the next whole minute at or after the delay.
- at: one run at a local date and time, "YYYY-MM-DDTHH:MM" ("3:47pm today" → "<today's date>T15:47"). A time already past is refused, never moved to another day.
- cron: repeating, 5 fields (minute hour day-of-month month day-of-week) in local time; never convert to UTC. Fields take numbers, *, ranges (1-5), lists (1,15), steps (*/10); no names (MON, JAN). Every 5 minutes "*/5 * * * *"; hourly at :07 "7 * * * *"; weekdays 09:00 "0 9 * * 1-5".

## The answer
The call waits for the daemon. "Scheduled <id> …" gives the 8-character id and the fire time in local time and UTC: tell the user that time; ${CRON_DELETE_TOOL_NAME} with that id cancels. A refusal means nothing was scheduled; it says why and what to do next. "NOT confirmed" means the request may have landed: check ${CRON_LIST_TOOL_NAME} before retrying. "Queued, not confirmed …" means an older daemon took the request without answering: check ${CRON_LIST_TOOL_NAME} before telling the user anything is scheduled.

## Firing
- The daemon checks every 30 seconds: a fire lands within 30 seconds after its time, only while the session is idle.
- It runs on this session's model and account. A fire the sign-in cannot serve (expired, rate-limited) is held with a receipt until /logins releases it; a fire due while the machine slept runs late, or past the catch-up window is recorded as missed. Never silently dropped.
- A parked session is woken; onParked: "queue" holds the fire for its own next wake instead.
- A schedule outlives interrupts; for a self-paced loop that should end when the user interrupts, use ScheduleWakeup (one wake, 1 to 60 minutes).
- At most 50 schedules per session.

## Prompt and title
The prompt comes back verbatim at each fire with no memory of why it was set: make it self-contained (1 to 20,000 characters) and never put a secret in it; it is stored with the schedule. Give a short title ("morning brief") when the user named the task; fires and ${CRON_LIST_TOOL_NAME} show it in place of the id. Mention the ${SATURN_BOARD_COMMAND} board, where the user sees every schedule.`
}

export const CRON_DELETE_DESCRIPTION = "Take a schedule off this session's clock, by id."

export function buildCronDeletePrompt(): string {
  return `Cancel a schedule on this session's record. Pass the id ${CRON_CREATE_TOOL_NAME} returned or ${CRON_LIST_TOOL_NAME} shows. The removal travels on the session's next facts beat and is receipted.`
}

export const CRON_LIST_DESCRIPTION = "List this session's schedules."

export function buildCronListPrompt(): string {
  return `List this session's schedules as the daemon last pushed them: id, human-readable timing, one-shot or recurring, fire-into-session or session-birth, next fire, paused state. A schedule ${CRON_CREATE_TOOL_NAME} answered "Scheduled" is listed already; one it answered "Queued, not confirmed" appears once the daemon applies it.`
}
