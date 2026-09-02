import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SATURN_ID_PATTERN } from '../../daemon/saturn.js'
import {
  sessionScheduleRoster,
  submitSessionScheduleEdit,
} from '../../services/saturn/sessionScheduleBridge.js'
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  cronToolsMountable,
} from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

/** Cancels one of this session's schedules by id (the daemon's mint). */

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe(`The schedule id to cancel (eight hex characters — ${CRON_LIST_TOOL_NAME} shows them)`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    note: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type DeleteOutput = z.infer<OutputSchema>

export const CronDeleteTool = buildTool({
  name: CRON_DELETE_TOOL_NAME,
  searchHint: 'cancel a scheduled job by id',
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
    return input.id
  },
  async description() {
    return CRON_DELETE_DESCRIPTION
  },
  async prompt() {
    return buildCronDeletePrompt()
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    if (!SATURN_ID_PATTERN.test(input.id)) {
      return { result: false, message: `A schedule id is eight hex characters — ${CRON_LIST_TOOL_NAME} shows them.`, errorCode: 1 }
    }
    const roster = sessionScheduleRoster()
    if (roster !== null && !roster.some(row => row.id === input.id)) {
      return {
        result: false,
        message: `No schedule '${input.id}' on the daemon's latest roster — ${CRON_LIST_TOOL_NAME} shows what stands.`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input: Input) {
    const submitted = submitSessionScheduleEdit({ op: 'remove', scheduleId: input.id })
    if (submitted.road === 'refused') {
      throw new Error(`${CRON_DELETE_TOOL_NAME}: ${submitted.reason}`)
    }
    return {
      data: {
        id: input.id,
        note: 'Removal submitted — the daemon applies it at the facts beat; the session receipt confirms.',
      } satisfies DeleteOutput,
    }
  },
  mapToolResultToToolResultBlockParam(output: DeleteOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Cancel submitted for schedule ${output.id}. ${output.note}`,
    }
  },
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<InputSchema, DeleteOutput>)
