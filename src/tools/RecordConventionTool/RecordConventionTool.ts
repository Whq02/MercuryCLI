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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    rule: z
      .string()
      .describe('Convention as one plain standing-order sentence'),
    replaces: z
      .string()
      .optional()
      .describe('Distinctive substring of the superseded rule line to swap in place'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['recorded', 'updated', 'already-recorded', 'replace-miss', 'invalid', 'not-recorded']),
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

export const UNANSWERED_ASK = 'unansweredAsk'
type CallInput = z.infer<InputSchema> & { [UNANSWERED_ASK]?: string }

export function unansweredConventionNote(rule: string, path: string): string {
  return `Not recorded — this run has no one to answer the ask, so nothing was written. Mercury would have asked permission to write "${rule}" into ${path}. Tell the user the convention was not recorded; a run launched with --allowed-tools ${RECORD_CONVENTION_TOOL_NAME} records it without the ask.`
}

export const RecordConventionTool: Unbuilt = unbuilt('src/tools/RecordConventionTool/RecordConventionTool.ts:60')
