
import { z } from 'zod/v4'

import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'

import { lazySchema } from '../../utils/lazySchema.js'
import { plural } from '../../utils/stringUtils.js'
import { resolveAttachments, validateAttachmentPaths } from '../BriefTool/attachments.js'
import { DESCRIPTION, SEND_USER_FILE_TOOL_NAME, SEND_USER_FILE_TOOL_PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    files: z
      .array(z.string())
      .min(1)
      .describe('Paths of the files to deliver (absolute, or relative to cwd).'),
    caption: z
      .string()
      .optional()
      .describe('Optional one-line caption shown with the file(s).'),
    status: z
      .enum(['normal', 'proactive'])
      .describe(
        `'proactive' when you are initiating the delivery — a file the user didn't just ask for but should see now (a finished artifact, a generated report). 'normal' when the delivery answers what the user just said.`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => {
  const attachment = z.object({
    path: z.string(),
    size: z.number(),
    isImage: z.boolean(),
    file_uuid: z.string().optional(),
    media_type: z.string().optional(),
  })
  return z.object({
    caption: z.string().optional(),
    attachments: z.array(attachment).describe('Resolved file metadata'),
  })
})
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function isSendUserFileEnabled(): boolean {
  return false
}

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  searchHint:
    'deliver files (screenshots, reports, artifacts) to the user',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  renderToolUseMessage() {
    return ''
  },
  isEnabled() {
    return isSendUserFileEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.caption ?? `[${input.files?.length ?? 0} file(s)]`
  },
  async validateInput({ files }, _context): Promise<ValidationResult> {
    return validateAttachmentPaths(files)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SEND_USER_FILE_TOOL_PROMPT
  },
  async call({ files, caption, status }, context) {
    void status
    const appState = context.getAppState()
    const attachments = await resolveAttachments(files, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: { caption, attachments },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const count = output.attachments.length
    let content = `${count} ${plural(count, 'file')} delivered to user.`
    const uploaded = output.attachments.filter(a => a.file_uuid !== undefined)
    if (uploaded.length > 0) {
      content += `\n${uploaded.map(a => `  ${a.path} → file_uuid: ${a.file_uuid}`).join('\n')}`
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
