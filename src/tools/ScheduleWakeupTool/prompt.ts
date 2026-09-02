import {
  cronToolsMountable,
} from '../ScheduleCronTool/prompt.js'

export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup'

/** Clamp bounds for the self-wake delay, in seconds (1 minute .. 1 hour). */
export const WAKEUP_MIN_DELAY_SECONDS = 60
export const WAKEUP_MAX_DELAY_SECONDS = 3600

/**
 * Gate for the self-paced wake tool. Shares the scheduling cluster's gate
 * (CronCreate/Delete/List) — the wake tool is a thin convenience over the
 * same session-schedule road, so it appears and disappears with it
 * (SATURN's kill switch + the one-shot headless mount suppression).
 */
export function isScheduleWakeupEnabled(): boolean {
  return cronToolsMountable()
}

export const SCHEDULE_WAKEUP_DESCRIPTION =
  'Schedule your own next wake: enqueue a prompt to fire once after a short delay (60s–1h) in this session. Use to pace a self-directed loop — do some work now, then schedule the next step.'

export function buildScheduleWakeupPrompt(): string {
  return `Schedule a single self-paced wake. After ${WAKEUP_MIN_DELAY_SECONDS}–${WAKEUP_MAX_DELAY_SECONDS} seconds the given prompt is enqueued once into THIS session. On a daemon-hosted session the wake rides the session record (the daemon fires it, receipted, then it removes itself); on a bare streaming run it is a process-local timer that dies with the run.

This is the native way to run a self-paced loop: instead of a fixed cron cadence, you do a unit of work now and call ${SCHEDULE_WAKEUP_TOOL_NAME} to wake yourself for the next unit. To continue the loop, the prompt you schedule should itself call ${SCHEDULE_WAKEUP_TOOL_NAME} again when more work remains; to stop, simply don't reschedule.

## Input
- delaySeconds: how long to wait before the wake fires. Clamped to [${WAKEUP_MIN_DELAY_SECONDS}, ${WAKEUP_MAX_DELAY_SECONDS}] seconds. Because the scheduler's resolution is one minute, the actual fire lands on the next minute boundary at or after the delay.
- prompt: the instruction to run when you wake.
- reason: optional short note on why you're waking yourself (for your own continuity; not shown to the user).

## When to use
- "check back in a few minutes once the build finishes" → delaySeconds: 120
- pacing a long self-directed task across several wakes without burning a turn idling
- Do NOT use for fixed recurring schedules ("every 5 minutes", "every day at 9am") — use ${'CronCreate'} for those. This tool fires exactly once per call.

The wake fires only while the session is idle (not mid-turn), same as all scheduled prompts.`
}
