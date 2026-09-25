import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { computeNextCronRun, cronToHuman, parseCronExpression } from '../../utils/cron.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import {
  sessionScheduleRoster,
  submitSessionScheduleEdit,
} from '../../services/saturn/sessionScheduleBridge.js'
import { cleanSaturnTitle, SATURN_SCHEDULE_CAP, SATURN_TITLE_SHAPE, saturnSecretProseRefusal, saturnTitleRefusal } from '../../daemon/saturn.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  cronToolsMountable,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'


const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z
      .string()
      .describe('A 5-field cron expression in local time: minute hour day-of-month month day-of-week'),
    prompt: z.string().describe('The prompt to enqueue each time the schedule fires'),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      'Whether the schedule repeats (default true). Pass false for a one-shot that fires once at the next match and removes itself.',
    ),
    onParked: z
      .enum(['wake', 'queue'])
      .optional()
      .describe(
        "What a fire does when the session is parked: 'wake' (default) reactivates the session and delivers; 'queue' holds the fire for the session's own next wake.",
      ),
    title: z
      .string()
      .optional()
      .describe(
        'A short name for the schedule (one line of at most 200 characters), shown on its rows in the chat and the list in place of the id — "morning brief", "nightly audit".',
      ),
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
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

function refuse(message: string, errorCode: number): ValidationResult {
  return { result: false, message, errorCode }
}

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: 'schedule a recurring or one-shot prompt on a cron expression',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled: () => cronToolsMountable(),
  toAutoClassifierInput(input: Input): string {
    return `${input.cron}: ${input.prompt}`
  },
  async description() {
    return buildCronCreateDescription()
  },
  async prompt() {
    return buildCronCreatePrompt()
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    const fields = parseCronExpression(input.cron)
    if (!fields) {
      return refuse(
        `Invalid cron expression "${input.cron}". Expected 5 fields: minute hour day-of-month month day-of-week.`,
        1,
      )
    }
    if (computeNextCronRun(fields, new Date()) === null) {
      return refuse('No calendar date matches this cron expression within the next year.', 2)
    }
    const roster = sessionScheduleRoster()
    if (roster !== null && roster.length >= SATURN_SCHEDULE_CAP) {
      return refuse(
        `This session already holds ${SATURN_SCHEDULE_CAP} schedules (the cap). Remove one with ${CRON_DELETE_TOOL_NAME} first.`,
        3,
      )
    }
    if (input.title !== undefined && cleanSaturnTitle(input.title) === null) {
      return refuse(`The title must be ${SATURN_TITLE_SHAPE}.`, 4)
    }
    return { result: true }
  },
  async call(input: Input) {
    const secretReason = saturnSecretProseRefusal('prompt', input.prompt)
    if (secretReason !== null) {
      throw new Error(`${CRON_CREATE_TOOL_NAME}: ${secretReason}`)
    }
    const titleReason = input.title === undefined ? null : saturnTitleRefusal(input.title)
    if (titleReason !== null) {
      throw new Error(`${CRON_CREATE_TOOL_NAME}: ${titleReason}`)
    }
    const title = input.title === undefined ? undefined : cleanSaturnTitle(input.title) ?? undefined
    const recurring = input.recurring ?? true
    const humanSchedule = cronToHuman(input.cron)
    const when = recurring
      ? { kind: 'every' as const, cron: input.cron, spelling: humanSchedule }
      : {
          kind: 'at' as const,
          atMs: computeNextCronRun(parseCronExpression(input.cron)!, new Date())!.getTime(),
          spelling: humanSchedule,
        }
    const submitted = submitSessionScheduleEdit({
      op: 'add',
      schedule: {
        when,
        action: {
          kind: 'fire',
          prompt: input.prompt,
          ...(input.onParked !== undefined ? { onParked: input.onParked } : {}),
        },
        ...(title !== undefined ? { title } : {}),
      },
    })
    if (submitted.road === 'refused') {
      throw new Error(`${CRON_CREATE_TOOL_NAME}: ${submitted.reason}`)
    }
    return {
      data: {
        submitted: true,
        humanSchedule,
        recurring,
        ...(title !== undefined ? { title } : {}),
        note: `Submitted to the session's schedule — the daemon applies it at the facts beat and mints the id; ${CRON_LIST_TOOL_NAME} then shows it, and the session receipt confirms.`,
      } satisfies CreateOutput,
    }
  },
  mapToolResultToToolResultBlockParam(output: CreateOutput, toolUseID: string) {
    const kind = output.recurring ? 'Recurring' : 'One-shot'
    const named = output.title !== undefined ? ` "${output.title}"` : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `${kind} schedule${named} submitted: ${output.humanSchedule}. ${output.note}`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
