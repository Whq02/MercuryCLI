import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { computeNextCronRun, cronToHuman, parseCronExpression } from '../../utils/cron.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import {
  sessionScheduleRoster,
  submitSessionScheduleEdit,
} from '../../services/saturn/sessionScheduleBridge.js'
import { SATURN_SCHEDULE_CAP, saturnSecretProseRefusal } from '../../daemon/saturn.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  cronToolsMountable,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

/** Schedules a prompt on a 5-field cron expression — SATURN's session-fact
 *  road: the submission rides the facts beat to the daemon, which applies
 *  it to the SESSION RECORD (the id is the daemon's mint, shown by
 *  CronList once applied). */

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
    // The next-run computation is bounded at a year: null ⇒ no match.
    if (computeNextCronRun(fields, new Date()) === null) {
      return refuse('No calendar date matches this cron expression within the next year.', 2)
    }
    // A soft early cap off the daemon's last roster push — the record's own
    // cap is the law and refuses at apply either way.
    const roster = sessionScheduleRoster()
    if (roster !== null && roster.length >= SATURN_SCHEDULE_CAP) {
      return refuse(
        `This session already holds ${SATURN_SCHEDULE_CAP} schedules (the cap). Remove one with ${CRON_DELETE_TOOL_NAME} first.`,
        3,
      )
    }
    return { result: true }
  },
  async call(input: Input) {
    // The early refusal where the model hears it best; the daemon
    // validator carries the SAME one-home guard as the belt for every
    // other persisting door (LM-7's re-home ruling).
    const secretReason = saturnSecretProseRefusal('prompt', input.prompt)
    if (secretReason !== null) {
      throw new Error(`${CRON_CREATE_TOOL_NAME}: ${secretReason}`)
    }
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
        note: `Submitted to the session's schedule — the daemon applies it at the facts beat and mints the id; ${CRON_LIST_TOOL_NAME} then shows it, and the session receipt confirms.`,
      } satisfies CreateOutput,
    }
  },
  mapToolResultToToolResultBlockParam(output: CreateOutput, toolUseID: string) {
    const kind = output.recurring ? 'Recurring' : 'One-shot'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `${kind} schedule submitted: ${output.humanSchedule}. ${output.note}`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
