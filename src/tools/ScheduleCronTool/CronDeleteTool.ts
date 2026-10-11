import { z } from 'zod/v4'
import { SATURN_ID_PATTERN } from '../../daemon/saturn.js'
import { sessionScheduleRoster, submitSessionScheduleEdit } from '../../services/saturn/sessionScheduleBridge.js'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { buildCronDeletePrompt, CRON_DELETE_DESCRIPTION, CRON_DELETE_TOOL_NAME, CRON_LIST_TOOL_NAME, cronToolsMountable } from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

const ID_HINT = `The schedule id to cancel (eight hex characters — ${CRON_LIST_TOOL_NAME} shows them)`

const inputSchema = lazySchema(() => z.strictObject({ id: z.string().describe(ID_HINT) }))
const outputSchema = lazySchema(() => z.object({ id: z.string(), note: z.string() }))
type DeleteInput = z.infer<ReturnType<typeof inputSchema>>
export type DeleteOutput = z.infer<ReturnType<typeof outputSchema>>

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

function submitRemoval(id: string): DeleteOutput {
  const submitted = submitSessionScheduleEdit({ op: 'remove', scheduleId: id })
  if (submitted.road === 'refused') throw new Error(`${CRON_DELETE_TOOL_NAME}: ${submitted.reason}`)
  return { id, note: REMOVAL_NOTE }
}

export const CronDeleteTool = buildTool({
  name: CRON_DELETE_TOOL_NAME,
  searchHint: 'cancel a scheduled job by id',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): ReturnType<typeof inputSchema> { return inputSchema() },
  get outputSchema(): ReturnType<typeof outputSchema> { return outputSchema() },
  isEnabled: () => cronToolsMountable(),
  description: async () => CRON_DELETE_DESCRIPTION,
  prompt: async () => buildCronDeletePrompt(),
  validateInput: async (input: DeleteInput): Promise<ValidationResult> => validateId(input.id),
  call: async (input: DeleteInput) => ({ data: submitRemoval(input.id) }),
  mapToolResultToToolResultBlockParam: (output: DeleteOutput, toolUseID: string) => ({ tool_use_id: toolUseID, type: 'tool_result' as const, content: `Cancel submitted for schedule ${output.id}. ${output.note}` }),
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<ReturnType<typeof inputSchema>, DeleteOutput>)
