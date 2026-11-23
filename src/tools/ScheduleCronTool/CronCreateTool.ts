import { z } from 'zod/v4'

import { buildTool, type Tool, type ToolDef, type ValidationResult } from '../../Tool.js'
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

const outputSchema = lazySchema(() =>
  z.object({
    submitted: z.boolean(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    note: z.string(),
    title: z.string().optional(),
    state: z.enum(['scheduled', 'queued']).optional(),
    id: z.string().optional(),
    cron: z.string().optional(),
    nextFireMs: z.number().optional(),
    nextFireLocal: z.string().optional(),
    nextFireUtc: z.string().optional(),
    timeZone: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
)
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

export const CronCreateTool: Tool<InputSchema, CreateOutput> = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: 'schedule a prompt once (after a delay or at a time) or repeating on cron; answers id and fire time',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  isEnabled: () => cronToolsMountable(),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return buildCronCreateDescription()
  },
  async prompt() {
    return buildCronCreatePrompt()
  },
  validateInput(input: Input): ValidationResult {
    const resolved = resolveCreateTime(input, Date.now())
    if (typeof resolved === 'string') return refuse(resolved)
    const normalized = input.prompt.replace(/\r\n/g, '\n').trim()
    if (normalized.length === 0) {
      return refuse('prompt is empty: pass the words to run when the schedule fires. Nothing was scheduled.')
    }
    if (normalized.length > SATURN_PROMPT_CAP) {
      return refuse(
        `prompt is ${normalized.length.toLocaleString('en-US')} characters; a schedule holds at most ${SATURN_PROMPT_CAP.toLocaleString('en-US')}. Put the long instructions in a file and schedule a short prompt that names the file. Nothing was scheduled.`,
      )
    }
    if (input.title !== undefined && cleanSaturnTitle(input.title) === null) {
      return refuse(`The title must be ${SATURN_TITLE_SHAPE}: shorten it, or leave title out. Nothing was scheduled.`)
    }
    const roster = sessionScheduleRoster()
    if (roster !== null && roster.length >= SATURN_SCHEDULE_CAP) {
      return refuse(
        `This session already holds ${SATURN_SCHEDULE_CAP} schedules (the cap). Call CronList, remove one with CronDelete, then call CronCreate again. Nothing was scheduled.`,
      )
    }
    return { result: true }
  },
  async call(input: Input, context) {
    const promptSecret = saturnSecretProseRefusal('prompt', input.prompt)
    if (promptSecret !== null) throw new Error(`CronCreate: ${promptSecret}. Nothing was scheduled.`)
    if (input.title !== undefined) {
      const titleProblem = saturnTitleRefusal(input.title)
      if (titleProblem !== null) throw new Error(`CronCreate: ${titleProblem}. Nothing was scheduled.`)
    }
    const signal = context?.abortController?.signal
    signal?.throwIfAborted()
    const resolved = resolveCreateTime(input, Date.now())
    if (typeof resolved === 'string') throw new Error(`CronCreate: ${resolved}`)
    if (!scheduleSeatObserved()) {
      throw new Error(
        'CronCreate: nothing was scheduled. This run has no session record on the Mercury daemon, and schedules live on that record (sessions the daemon hosts have one; this run does not). Tell the user. Inside this run, ScheduleWakeup may still arm one wake of 1 to 60 minutes that ends with the run. Nothing was scheduled.',
      )
    }
    const title = input.title !== undefined ? (cleanSaturnTitle(input.title) ?? undefined) : undefined
    const edit: ScheduleOpRequestV1 = {
      op: 'add',
      schedule: {
        when: resolved.when,
        action: {
          kind: 'fire',
          prompt: input.prompt,
          ...(input.onParked !== undefined ? { onParked: input.onParked } : {}),
        },
        ...(title !== undefined ? { title } : {}),
      },
    }
    const submitLegacy = (older: boolean): { data: CreateOutput } => {
      const outcome = submitSessionScheduleEdit(edit)
      if (outcome.road === 'refused') {
        throw new Error(
          'CronCreate: nothing was scheduled. 20 schedule edits are already waiting for the daemon; wait a few seconds, then call CronCreate again. Nothing was scheduled.',
        )
      }
      return {
        data: {
          submitted: true,
          humanSchedule: resolved.humanSchedule,
          recurring: resolved.recurring,
          ...(title !== undefined ? { title } : {}),
          state: 'queued',
          note: scheduleQueued(resolved.humanSchedule, older),
        },
      }
    }
    if (scheduleEditDoor() === null) {
      return submitLegacy(false)
    }
    let answer: ScheduleEditAnswer
    try {
      answer = await askSchedule(edit, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
      if (code === RPC_METHOD_NOT_FOUND) {
        return submitLegacy(true)
      }
      const reason =
        error instanceof PeerDeadline
          ? 'The daemon did not answer within 10 seconds'
          : error instanceof PeerClosed
            ? 'The connection to the daemon closed before it answered'
            : 'The daemon did not return a usable answer'
      throw new Error(scheduleUnconfirmed(reason, resolved.humanSchedule))
    }
    if (answer.outcome !== 'applied') {
      throw new Error(scheduleRefusal(answer.detail ?? 'no schedule was applied'))
    }
    const id = answer.schedule_id
    const nextFireMs = answer.next_fire_ms
    const timeZone = answer.time_zone
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}$/.test(id) ||
      typeof nextFireMs !== 'number' ||
      !Number.isFinite(nextFireMs) ||
      typeof timeZone !== 'string' ||
      timeZone === ''
    ) {
      throw new Error(
        scheduleUnconfirmed('The daemon answered without the schedule id or fire time', resolved.humanSchedule),
      )
    }
    let nextFireLocal: string
    let nextFireUtc: string
    let warnings: string[]
    try {
      nextFireLocal = createLocalTime(nextFireMs, timeZone)
      nextFireUtc = new Date(nextFireMs).toISOString()
      warnings = scheduleWarnings(answer, resolved.recurring)
    } catch {
      throw new Error(scheduleUnconfirmed('The daemon answered with an unreadable fire time', resolved.humanSchedule))
    }
    latchScheduleRow({
      id,
      when: resolved.humanSchedule,
      kind: 'fire',
      nextFireMs,
      ...(title !== undefined ? { title } : {}),
    })
    const note = `The daemon fires it within 30 seconds after ${resolved.recurring ? 'each' : 'that'} time, once the session is idle. Cancel: CronDelete with id "${id}". The user sees it on the /saturn board.`
    return {
      data: {
        submitted: true,
        humanSchedule: resolved.humanSchedule,
        recurring: resolved.recurring,
        ...(title !== undefined ? { title } : {}),
        state: 'scheduled',
        id,
        ...(resolved.recurring && input.cron !== undefined ? { cron: input.cron } : {}),
        nextFireMs,
        nextFireLocal,
        nextFireUtc,
        timeZone,
        ...(warnings.length > 0 ? { warnings } : {}),
        note,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: CreateOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: createResultText(output),
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
