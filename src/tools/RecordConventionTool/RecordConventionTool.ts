import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import {
  captureProjectInstruction,
  describeCaptureResult,
  resolveCaptureTargetPath,
  type CaptureResult,
} from '../../services/instructions/projectInstructionWriter.js'
import {
  RECORD_CONVENTION_DESCRIPTION,
  RECORD_CONVENTION_TOOL_NAME,
  buildRecordConventionPrompt,
} from './prompt.js'
import {
  renderRecordConventionResultMessage,
  renderRecordConventionToolUseMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    rule: z
      .string()
      .describe('the durable project convention, as one plain standing-order sentence'),
    replaces: z
      .string()
      .optional()
      .describe(
        'merge verb: a distinctive substring of the EXISTING rule line this one supersedes — the old line is swapped in place instead of a near-copy appended',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['recorded', 'updated', 'already-recorded', 'replace-miss', 'invalid']),
    path: z.string().optional(),
    detail: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type RecordConventionOutput = z.infer<OutputSchema>

function toOutput(result: CaptureResult): RecordConventionOutput {
  return {
    action: result.action,
    path: 'path' in result ? result.path : undefined,
    detail: describeCaptureResult(result),
  }
}

export const RecordConventionTool = buildTool({
  name: RECORD_CONVENTION_TOOL_NAME,
  searchHint:
    'record a user-stated durable project convention into MERCURY.md or its pointed guide',
  maxResultSizeChars: 10_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return input.rule
  },
  capability: {
    intents: [
      'record a user-stated project convention',
      'update a standing rule in the instruction estate',
    ],
    units: ['text-mutation'],
    class: 'mutation',
    transaction: { kind: 'file', receipts: true },
    evidence: ['change'],
    cancellation: 'not-applicable',
    latency: 'fast',
  },
  async description() {
    return RECORD_CONVENTION_DESCRIPTION
  },
  async prompt() {
    return buildRecordConventionPrompt()
  },
  getPath() {
    return resolveCaptureTargetPath(getCwd())
  },
  getActivityDescription(input): string {
    return input?.rule ? 'Recording a project convention' : 'Recording'
  },
  async checkPermissions(input, context) {
    return checkWritePermissionForTool(
      {
        name: RECORD_CONVENTION_TOOL_NAME,
        getPath: () => resolveCaptureTargetPath(getCwd()),
      },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  async call(input) {
    const startedAt = Date.now()
    const cwd = getCwd()
    const intendedPath = resolveCaptureTargetPath(cwd)
    const result = captureProjectInstruction({
      cwd,
      rule: input.rule,
      replaces: input.replaces,
    })
    const output = toOutput(result)
    const wrote = result.action === 'recorded' || result.action === 'updated'
    return {
      data: output,
      changeIntent: { targetPaths: [intendedPath] },
      effect: {
        outcome: wrote ? ('succeeded' as const) : ('no-change' as const),
        operation: 'file.convention',
        changedPaths: wrote && output.path !== undefined ? [output.path] : [],
        evidence: output.detail,
        startedAt,
        completedAt: Date.now(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: RecordConventionOutput, toolUseID: string) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: output.detail }
  },
  renderToolUseMessage: renderRecordConventionToolUseMessage,
  renderToolResultMessage: renderRecordConventionResultMessage,
} satisfies ToolDef<InputSchema, RecordConventionOutput>)
