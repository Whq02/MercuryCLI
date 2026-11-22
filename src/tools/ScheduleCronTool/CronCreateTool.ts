import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { PeerClosed, PeerDeadline } from '../../runner/wire/peer.js'
import { RPC_METHOD_NOT_FOUND } from '../../runner/wire/errors.js'
import {
  latchScheduleRow,
  scheduleEditDoor,
  scheduleSeatObserved,
  sessionScheduleRoster,
  submitSessionScheduleEdit,
  type ScheduleEditAnswer,
} from '../../services/saturn/sessionScheduleBridge.js'
import { cleanSaturnTitle, SATURN_SCHEDULE_CAP, SATURN_PROMPT_CAP, SATURN_TITLE_SHAPE, saturnSecretProseRefusal, saturnTitleRefusal, type ScheduleOpRequestV1 } from '../../daemon/saturn.js'
import { buildCronCreateDescription, buildCronCreatePrompt, CRON_CREATE_TOOL_NAME, cronToolsMountable } from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'
import { createLocalTime, resolveCreateTime } from './createTime.js'
import { createResultText, scheduleQueued, scheduleRefusal, scheduleUnconfirmed, scheduleWarnings } from './createAnswer.js'
import { withDeadline } from '../../utils/deadline.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z.string().optional().describe('Repeating 5-field cron (min hr dom mon dow) in local time, never UTC; numbers, *, ranges (1-5), lists (1,15), steps (*/10), no names. Pass exactly one of cron, at, delayMinutes.'),
    at: z.string().optional().describe('Future one-shot local time "YYYY-MM-DDTHH:MM" (optional offset like "Z" or "+01:00").'),
    delayMinutes: semanticNumber(z.number().min(1).max(525_600)).optional().describe('One-shot delay in minutes (fires on next whole minute at or after delay).'),
    prompt: z.string().describe('Self-contained prompt (1–20,000 chars, no secrets); delivered verbatim at each fire with no memory of why it was set.'),
    recurring: semanticBoolean(z.boolean().optional()).describe('cron only: default true; false fires once then deletes itself (prefer at or delayMinutes for one-shots).'),
    onParked: z.enum(['wake', 'queue']).optional().describe("When parked: 'wake' (default) reactivates and delivers; 'queue' holds until next wake."),
    title: z.string().optional().describe('Short schedule name (one line of at most 200 characters) shown on chat/list rows instead of id; use the user\'s task name when given.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema: Unbuilt = unbuilt('src/tools/ScheduleCronTool/CronCreateTool.ts:39')
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>
const CRON_CREATE_ANSWER_DEADLINE_MS = 10_000

function refuse(message: string, errorCode = 1): ValidationResult {
  return { result: false, message, errorCode }
}

async function askSchedule(edit: ScheduleOpRequestV1, signal: AbortSignal | undefined): Promise<ScheduleEditAnswer> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const seam = Number(flagEnv('MERCURY_SCHEDULE_ANSWER_DEADLINE_MS'))
  const ms = Number.isFinite(seam) && seam > 0 ? seam : CRON_CREATE_ANSWER_DEADLINE_MS
  return withDeadline(
    scheduleEditDoor()!(edit, controller.signal),
    ms,
    () => {
      const error = new PeerDeadline('schedule/edit', 0, ms)
      controller.abort(error)
      throw error
    },
    {
      signal,
      onAbort: () => {
        const reason = signal?.reason ?? new Error('Aborted')
        controller.abort(signal?.reason)
        throw reason
      },
    },
  )
}

export const CronCreateTool: Unbuilt = unbuilt('src/tools/ScheduleCronTool/CronCreateTool.ts:88')
