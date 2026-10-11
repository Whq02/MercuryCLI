import { z } from 'zod/v4'
import { findActiveCheckpoint } from '../../services/compact/checkpointRewind.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { contextOnlyTraits, refusal } from '../CheckpointTool/contextOnlyTool.js'
import { DESCRIPTION, REWIND_TOOL_NAME, REWIND_TOOL_PROMPT } from './prompt.js'

const HEADER_CHARS = 80

const inputSchema = lazySchema(() =>
  z.strictObject({
    report: z.string().describe('The carried-back handoff: findings, decisions, exact paths, next steps. Required, non-empty after trim.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Human-readable confirmation'),
    goal: z.string().describe('The checkpoint goal being returned to'),
    abandonedMessages: z.number().describe('How many messages the rewind will drop from context'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const emptyReport = (): Error => refusal('the report is empty — the report is the one artifact that survives the rewind; write the findings before rewinding.')

const noCheckpoint = (): Error => refusal('no active checkpoint — Checkpoint { goal } takes one before an exploration; a checkpoint already rewound cannot be rewound again.')

const accepted = (abandoned: number): string =>
  `Rewind accepted — applies at the end of this turn. The next model call sees the pre-exploration context ` +
  `(${abandoned} message(s) leave the model context; the operator's transcript keeps them; files/git untouched).`

const headerOf = (report: string): string => (report.length > HEADER_CHARS ? `${report.slice(0, HEADER_CHARS - 3)}…` : report)

export const RewindTool = buildTool({
  ...contextOnlyTraits(),
  name: REWIND_TOOL_NAME,
  searchHint: 'rewind context to the checkpoint, carry a report back',
  userFacingName: () => 'Rewind',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return REWIND_TOOL_PROMPT
  },
  getActivityDescription: () => 'Rewinding to the checkpoint',
  renderToolUseMessage: input => headerOf(input?.report ?? ''),
  async call({ report }, context) {
    if (report.trim() === '') throw emptyReport()
    const messages = context.messages ?? []
    const active = findActiveCheckpoint(messages)
    if (active === null) throw noCheckpoint()
    const abandoned = Math.max(0, messages.length - (active.boundaryIndex + 1))
    const data: Output = { message: accepted(abandoned), goal: active.goal, abandonedMessages: abandoned }
    return { data }
  },
} satisfies ToolDef<InputSchema, Output>)
