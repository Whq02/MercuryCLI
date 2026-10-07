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

const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z.string().optional().describe('Repeating: 5 fields (minute hour day-of-month month day-of-week) in local time, e.g. "0 9 * * 1-5". Pass exactly one of cron, at, delayMinutes.'),
    at: z.string().optional().describe('One run at a local date and time, "YYYY-MM-DDTHH:MM" (an offset like "Z" or "+01:00" is accepted); must be in the future.'),
    delayMinutes: semanticNumber(z.number().min(1).max(525_600)).optional().describe('One run this many minutes from now (1 to 525600); it fires on the next whole minute at or after the delay.'),
    prompt: z.string().describe('What runs at each fire: self-contained, 1 to 20,000 characters, no secrets (it is stored with the schedule).'),
    recurring: semanticBoolean(z.boolean().optional()).describe('With cron only. Default true; false runs once at the next match, then removes itself (for one run prefer at or delayMinutes).'),
    onParked: z.enum(['wake', 'queue']).optional().describe("What a fire does when the session is parked: 'wake' (default) reactivates the session and delivers; 'queue' holds the fire for the session's own next wake."),
    title: z.string().optional().describe('A short name for the schedule (one line of at most 200 characters), shown on its rows in the chat and the list in place of the id — "morning brief", "nightly audit".'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    submitted: z.boolean(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    title: z.string().optional(),
    note: z.string(),
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
export const CRON_CREATE_ANSWER_DEADLINE_MS = 10_000

function refuse(message: string, errorCode = 1): ValidationResult {
  return { result: false, message, errorCode }
}

async function askSchedule(edit: ScheduleOpRequestV1, signal: AbortSignal | undefined): Promise<ScheduleEditAnswer> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const seam = Number(flagEnv('MERCURY_SCHEDULE_ANSWER_DEADLINE_MS'))
  const ms = Number.isFinite(seam) && seam > 0 ? seam : CRON_CREATE_ANSWER_DEADLINE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal?.reason ?? new Error('Aborted')); controller.abort(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      const error = new PeerDeadline('schedule/edit', 0, ms)
      reject(error)
      controller.abort(error)
    }, ms)
  })
  try {
    return await Promise.race([scheduleEditDoor()!(edit, controller.signal), interrupted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) signal?.removeEventListener('abort', abort)
  }
}

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: 'schedule a prompt once (after a delay or at a time) or repeating on cron; answers id and fire time',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema { return inputSchema() },
  get outputSchema(): OutputSchema { return outputSchema() },
  isEnabled: () => cronToolsMountable(),
  async description() { return buildCronCreateDescription() },
  async prompt() { return buildCronCreatePrompt() },
  async validateInput(input: Input): Promise<ValidationResult> {
    const resolved = resolveCreateTime(input, Date.now())
    if (typeof resolved === 'string') return refuse(resolved)
    const prompt = input.prompt.replace(/\r\n/g, '\n').trim()
    if (!prompt) return refuse('prompt is empty: pass the words to run when the schedule fires. Nothing was scheduled.')
    if (prompt.length > SATURN_PROMPT_CAP) return refuse(`prompt is ${prompt.length.toLocaleString('en-US')} characters; a schedule holds at most 20,000. Put the long instructions in a file and schedule a short prompt that names the file. Nothing was scheduled.`)
    if (input.title !== undefined && cleanSaturnTitle(input.title) === null) return refuse(`The title must be ${SATURN_TITLE_SHAPE}: shorten it, or leave title out. Nothing was scheduled.`)
    const roster = sessionScheduleRoster()
    if (roster !== null && roster.length >= SATURN_SCHEDULE_CAP) return refuse(`This session already holds ${SATURN_SCHEDULE_CAP} schedules (the cap). Call CronList, remove one with CronDelete, then call CronCreate again. Nothing was scheduled.`)
    return { result: true }
  },
  async call(input: Input, toolUseContext) {
    const secretReason = saturnSecretProseRefusal('prompt', input.prompt)
    if (secretReason !== null) throw new Error(`${CRON_CREATE_TOOL_NAME}: ${secretReason}. Nothing was scheduled.`)
    const titleReason = input.title === undefined ? null : saturnTitleRefusal(input.title)
    if (titleReason !== null) throw new Error(`${CRON_CREATE_TOOL_NAME}: ${titleReason}. Nothing was scheduled.`)
    toolUseContext.abortController?.signal.throwIfAborted()
    const resolved = resolveCreateTime(input, Date.now())
    if (typeof resolved === 'string') throw new Error(resolved)
    const { when, recurring, humanSchedule } = resolved
    if (!scheduleSeatObserved()) throw new Error('CronCreate: nothing was scheduled. This run has no session record on the Mercury daemon, and schedules live on that record (sessions the daemon hosts have one; this run does not). Tell the user. Inside this run, ScheduleWakeup may still arm one wake of 1 to 60 minutes that ends with the run. Nothing was scheduled.')
    const title = input.title === undefined ? undefined : cleanSaturnTitle(input.title) ?? undefined
    const edit: ScheduleOpRequestV1 = { op: 'add', schedule: {
      when,
      action: { kind: 'fire', prompt: input.prompt, ...(input.onParked !== undefined ? { onParked: input.onParked } : {}) },
      ...(title !== undefined ? { title } : {}),
    } }
    const base = { submitted: true, humanSchedule, recurring, ...(title !== undefined ? { title } : {}) }
    let older = false
    if (scheduleEditDoor() !== null) {
      let answer: ScheduleEditAnswer
      try {
        answer = await askSchedule(edit, toolUseContext.abortController?.signal)
      } catch (error) {
        if (toolUseContext.abortController?.signal.aborted) throw error
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === RPC_METHOD_NOT_FOUND) {
          older = true
        } else {
          const reason = error instanceof PeerDeadline ? 'The daemon did not answer within 10 seconds'
            : error instanceof PeerClosed ? 'The connection to the daemon closed before it answered'
            : 'The daemon did not return a usable answer'
          throw new Error(scheduleUnconfirmed(reason, humanSchedule))
        }
      }
      if (!older) {
        if (answer!.outcome !== 'applied') throw new Error(scheduleRefusal(answer!.detail ?? 'no schedule was applied'))
        const { schedule_id: id, next_fire_ms: nextFireMs, time_zone: timeZone } = answer!
        if (!id || !/^[0-9a-f]{8}$/.test(id) || typeof nextFireMs !== 'number' || !Number.isFinite(nextFireMs) || !timeZone) throw new Error(scheduleUnconfirmed('The daemon answered without the schedule id or fire time', humanSchedule))
        let nextFireLocal: string
        let warnings: string[]
        try {
          nextFireLocal = createLocalTime(nextFireMs, timeZone)
          warnings = scheduleWarnings(answer!, recurring)
        } catch {
          throw new Error(scheduleUnconfirmed('The daemon answered with an unreadable fire time', humanSchedule))
        }
        latchScheduleRow({ id, when: humanSchedule, kind: 'fire', nextFireMs, ...(title !== undefined ? { title } : {}) })
        return { data: {
          ...base, state: 'scheduled', id, ...(recurring ? { cron: input.cron } : {}),
          nextFireMs, nextFireLocal, nextFireUtc: new Date(nextFireMs).toISOString(), timeZone,
          note: `The daemon fires it within 30 seconds after ${recurring ? 'each' : 'that'} time, once the session is idle. Cancel: CronDelete with id "${id}". The user sees it on the /saturn board.`,
          ...(warnings.length ? { warnings } : {}),
        } satisfies CreateOutput }
      }
    }
    const submitted = submitSessionScheduleEdit(edit)
    if (submitted.road === 'refused') throw new Error('CronCreate: nothing was scheduled. 20 schedule edits are already waiting for the daemon; wait a few seconds, then call CronCreate again. Nothing was scheduled.')
    return { data: { ...base, state: 'queued', note: scheduleQueued(humanSchedule, older) } satisfies CreateOutput }
  },
  mapToolResultToToolResultBlockParam(output: CreateOutput, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: createResultText(output) }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
