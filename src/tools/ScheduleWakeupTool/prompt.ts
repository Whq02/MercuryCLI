import { cronToolsMountable } from '../ScheduleCronTool/prompt.js'

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'

export const WAKEUP_MIN_DELAY_SECONDS = 60
export const WAKEUP_MAX_DELAY_SECONDS = 3600

export function isScheduleWakeupEnabled(): boolean {
  return cronToolsMountable()
}

export const SCHEDULE_WAKEUP_DESCRIPTION =
  'Schedule your own next wake: enqueue a prompt to fire once after a short delay (60s–1h) in this session. Use to pace a self-directed loop — do some work now, then schedule the next step.'

export function buildScheduleWakeupPrompt(): string {
  return `Wakes this session once after ${WAKEUP_MIN_DELAY_SECONDS}–${WAKEUP_MAX_DELAY_SECONDS}s with prompt (on a minute boundary once idle; dropped on operator interrupt/stop, kept when parked). Daemon-hosted wakes persist with the session; bare runs use an in-process timer. It fires once: a loop continues only when the woken prompt schedules the next wake.`
}
