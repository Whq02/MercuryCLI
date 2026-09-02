import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { detectSecrets } from '../../memdir/experienceCards.js'
import { saturnSecretProseRefusal } from '../../daemon/saturn.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  applyWakeReason,
  armLocalWake,
  localWakeAvailable,
  scheduleSeatObserved,
  submitSessionScheduleEdit,
} from '../../services/saturn/sessionScheduleBridge.js'
import {
  buildScheduleWakeupPrompt,
  isScheduleWakeupEnabled,
  SCHEDULE_WAKEUP_DESCRIPTION,
  SCHEDULE_WAKEUP_TOOL_NAME,
  WAKEUP_MAX_DELAY_SECONDS,
  WAKEUP_MIN_DELAY_SECONDS,
} from './prompt.js'
import { renderWakeupResultMessage, renderWakeupToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: z
      .number()
      .describe(
        `Seconds to wait before the wake fires. Clamped to [${WAKEUP_MIN_DELAY_SECONDS}, ${WAKEUP_MAX_DELAY_SECONDS}]. The fire lands on the next minute boundary at/after the delay (cron resolution is 1 minute).`,
      ),
    prompt: z.string().describe('The prompt to enqueue when the wake fires.'),
    reason: z
      .string()
      .optional()
      .describe(
        'Optional short note on why you are waking yourself (for your own continuity; not shown to the user).',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    delaySeconds: z.number(),
    humanSchedule: z.string(),
    /** Which arm took the wake: 'session' — the schedule rides the session
     *  record (the daemon fires it, receipted); 'local' — a process-local
     *  timer in this run (a seatless streaming surface). */
    road: z.enum(['session', 'local']),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type WakeupOutput = z.infer<OutputSchema>

/** Clamp the requested delay into the supported window. */
function clampDelaySeconds(requested: number): number {
  if (!Number.isFinite(requested)) return WAKEUP_MIN_DELAY_SECONDS
  return Math.min(
    WAKEUP_MAX_DELAY_SECONDS,
    Math.max(WAKEUP_MIN_DELAY_SECONDS, Math.round(requested)),
  )
}

/**
 * Build a one-shot cron string (local time) that fires once at the minute
 * boundary at/after `now + delaySeconds`. Pins minute/hour/day-of-month/month
 * to the target instant with a wildcard day-of-week — the exact shape
 * CronCreate uses for a pinned "remind me at X" one-shot. Cron resolution is one
 * minute, so a sub-minute remainder rounds up to the next whole minute, which is
 * why the minimum delay is 60s.
 */
/** The wake's epoch instant: the minute boundary at/after now + delay —
 *  the same rounding buildOneShotCron pins into its expression. */
function nextWakeInstantMs(delaySeconds: number, nowMs: number): number {
  const target = new Date(nowMs + delaySeconds * 1000)
  if (target.getSeconds() !== 0 || target.getMilliseconds() !== 0) {
    target.setSeconds(0, 0)
    target.setMinutes(target.getMinutes() + 1)
  }
  return target.getTime()
}

function buildOneShotCron(delaySeconds: number, nowMs: number): string {
  const target = new Date(nowMs + delaySeconds * 1000)
  // Round up to the next whole minute so the pinned minute is strictly in the
  // future (a target with non-zero seconds would otherwise pin the CURRENT
  // minute, which nextCronRunMs treats as already past).
  if (target.getSeconds() !== 0 || target.getMilliseconds() !== 0) {
    target.setSeconds(0, 0)
    target.setMinutes(target.getMinutes() + 1)
  }
  const minute = target.getMinutes()
  const hour = target.getHours()
  const dom = target.getDate()
  const month = target.getMonth() + 1 // cron month is 1-12
  return `${minute} ${hour} ${dom} ${month} *`
}

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  searchHint: 'schedule your own next wake after a short delay',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isScheduleWakeupEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.delaySeconds}s: ${input.prompt}`
  },
  async description() {
    return SCHEDULE_WAKEUP_DESCRIPTION
  },
  async prompt() {
    return buildScheduleWakeupPrompt()
  },
  async call({ delaySeconds, prompt, reason }) {
    // The prompt PERSISTS (the session record on the seat road)
    // and is re-fed when the wake fires — a secret in it would land on disk
    // (and re-inject). The reason below is merely dropped if secret-bearing,
    // but the prompt is load-bearing and can't be silently dropped, so
    // refuse the call — through the ONE persisting-prose guard the daemon
    // validator also runs (LM-7's re-home ruling).
    const secretReason = saturnSecretProseRefusal('prompt', prompt)
    if (secretReason !== null) {
      throw new Error(`ScheduleWakeup: ${secretReason}`)
    }
    const clamped = clampDelaySeconds(delaySeconds)
    // ONE clock read for the whole call: the display cron and the stored
    // at-instant must pin the SAME minute (two reads straddling a minute
    // boundary made the tool display one minute and fire the next).
    const nowMs = Date.now()
    const cron = buildOneShotCron(clamped, nowMs)
    // The wake reason folds into the fired prompt as the continuity header
    // (MERCURY_WAKE_REASON; identity when absent/off) — never a
    // secret-bearing note (defense in depth; dropped if so).
    const safeReason = reason && detectSecrets(reason).length === 0 ? reason : undefined
    const fired = applyWakeReason(prompt, safeReason)
    const humanSchedule = cronToHuman(cron)
    if (scheduleSeatObserved()) {
      // The seat road: a one-shot session fact — the daemon fires it and
      // the receipt confirms; self-paced wakes pace the CURRENT run, so
      // the model re-arms by calling this tool again from the fired prompt.
      const submitted = submitSessionScheduleEdit({
        op: 'add',
        schedule: {
          when: { kind: 'at', atMs: nextWakeInstantMs(clamped, nowMs), spelling: `in ~${clamped}s` },
          action: { kind: 'fire', prompt: fired },
          ...(safeReason !== undefined ? { note: safeReason } : {}),
        },
      })
      if (submitted.road === 'refused') {
        throw new Error(`${SCHEDULE_WAKEUP_TOOL_NAME}: ${submitted.reason}`)
      }
      return { data: { delaySeconds: clamped, humanSchedule, road: 'session' as const } }
    }
    // The seatless arm: a process-local wake that lives exactly as long as
    // this run — the honest self-pacing primitive for a bare headless run.
    if (!localWakeAvailable()) {
      throw new Error(
        `${SCHEDULE_WAKEUP_TOOL_NAME}: this surface has no wake queue — a one-shot run cannot take a later fire.`,
      )
    }
    const armed = armLocalWake(clamped, fired)
    if (!armed.ok) throw new Error(`${SCHEDULE_WAKEUP_TOOL_NAME}: ${armed.reason}`)
    return { data: { delaySeconds: clamped, humanSchedule, road: 'local' as const } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const where =
      output.road === 'session'
        ? 'On the session record — the daemon fires it once (the receipt confirms), then it removes itself.'
        : 'Process-local — it fires once inside this run and dies with it.'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Wake armed in ~${output.delaySeconds}s (${output.humanSchedule}). ${where} Call ${SCHEDULE_WAKEUP_TOOL_NAME} again from the fired prompt to continue a self-paced loop.`,
    }
  },
  renderToolUseMessage: renderWakeupToolUseMessage,
  renderToolResultMessage: renderWakeupResultMessage,
} satisfies ToolDef<InputSchema, WakeupOutput>)
