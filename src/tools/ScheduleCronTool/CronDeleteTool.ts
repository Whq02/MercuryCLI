import { z } from 'zod/v4'
import { SATURN_ID_PATTERN } from '../../daemon/saturn.js'
import { sessionScheduleRoster, submitSessionScheduleEdit } from '../../services/saturn/sessionScheduleBridge.js'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  cronToolsMountable,
} from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe(`The schedule id to cancel (eight hex characters — ${CRON_LIST_TOOL_NAME} shows them)`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => z.object({ id: z.string(), note: z.string() }))
type OutputSchema = ReturnType<typeof outputSchema>
export type DeleteOutput = z.infer<OutputSchema>

const REMOVAL_NOTE = 'Removal submitted — the daemon applies it at the facts beat; the session receipt confirms.'

const refused = (message: string, errorCode: number): ValidationResult => ({ result: false, message, errorCode })

const wellFormed = (id: string): boolean => SATURN_ID_PATTERN.test(id)

function onKnownRoster(id: string): boolean {
  const roster = sessionScheduleRoster()
  return roster === null || roster.some(row => row.id === id)
}

const REFUSALS: ReadonlyArray<[test: (id: string) => boolean, refusal: (id: string) => ValidationResult]> = [
  [wellFormed, () => refused(`A schedule id is eight hex characters — ${CRON_LIST_TOOL_NAME} shows them.`, 1)],
  [onKnownRoster, id => refused(`No schedule '${id}' on the daemon's latest roster — ${CRON_LIST_TOOL_NAME} shows what stands.`, 2)],
]

function validateId(id: string): ValidationResult {
  const failed = REFUSALS.find(([test]) => !test(id))
  return failed ? failed[1](id) : { result: true }
}

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
  async description() {
    return CRON_DELETE_DESCRIPTION
  },
  async prompt() {
    return buildCronDeletePrompt()
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    return validateId(input.id)
  },
  async call(input: Input) {
    const submitted = submitSessionScheduleEdit({ op: 'remove', scheduleId: input.id })
    if (submitted.road === 'refused') throw new Error(`${CRON_DELETE_TOOL_NAME}: ${submitted.reason}`)
    const data: DeleteOutput = { id: input.id, note: REMOVAL_NOTE }
    return { data }
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
