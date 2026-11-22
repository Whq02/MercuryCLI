import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { detectSecrets } from '../../utils/detectSecrets.js'
import { saturnSecretProseRefusal } from '../../daemon/saturn.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { wakeDelaySpelling } from '../../utils/messages/noticeRows.js'
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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: z
      .number()
      .describe(
        `Seconds to wait (clamped to ${WAKEUP_MIN_DELAY_SECONDS}–${WAKEUP_MAX_DELAY_SECONDS}; fires on next minute boundary).`,
      ),
    prompt: z.string().describe('Prompt enqueued at wake.'),
    reason: z
      .string()
      .optional()
      .describe('Short continuity note heading the woken prompt and wake row.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    delaySeconds: z.number(),
    humanSchedule: z.string(),
    road: z.enum(['session', 'local']),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type WakeupOutput = z.infer<OutputSchema>

function clampDelaySeconds(requested: number): number {
  if (!Number.isFinite(requested)) return WAKEUP_MIN_DELAY_SECONDS
  return Math.min(
    WAKEUP_MAX_DELAY_SECONDS,
    Math.max(WAKEUP_MIN_DELAY_SECONDS, Math.round(requested)),
  )
}

function nextWakeInstantMs(delaySeconds: number, nowMs: number): number {
  const target = new Date(nowMs + delaySeconds * 1000)
  if (target.getSeconds() !== 0 || target.getMilliseconds() !== 0) {
    target.setSeconds(0, 0)
    target.setMinutes(target.getMinutes() + 1)
  }
  return target.getTime()
}

function buildOneShotCron(fireAtMs: number): string {
  const target = new Date(fireAtMs)
  const minute = target.getMinutes()
  const hour = target.getHours()
  const dom = target.getDate()
  const month = target.getMonth() + 1
  return `${minute} ${hour} ${dom} ${month} *`
}

export const ScheduleWakeupTool: Unbuilt = unbuilt('src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts:77')
