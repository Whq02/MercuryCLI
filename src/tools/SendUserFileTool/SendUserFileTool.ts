// =============================================================================
// SendUserFileTool — put a local file in the user's hands, outside the
// transcript: the screenshot they should look at, the report that just got
// written, the artifact that finished building.
//
// There is deliberately no second attachment implementation here. Checking
// paths, statting, and the optional upload that yields a file_uuid all reuse
// the Brief tool's pipeline (validateAttachmentPaths / resolveAttachments in
// ../BriefTool/attachments.js).
//
// Classified read-only and concurrency-safe — the workspace is never
// written, bytes just leave it.
//
// Availability tells the truth about the runtime: the provider must be
// first-party AND a remote-environment delivery channel must exist. Absent
// a channel the tool hides itself entirely; offering a delivery tool with
// no way to deliver would be strictly worse than not having one.
// =============================================================================

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

// media_type exists in the schema for forward compatibility only — the
// shared pipeline emits {path, size, isImage, file_uuid?} and nothing more.
// Declaring it optional means every value the pipeline can produce (and
// every value an old session may replay) validates.
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

/**
 * Availability: never — Mercury has no remote-session delivery
 * channel; a Mercury-own delivery rail would be its own
 * decision.
 */
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
    void status // read by the delivery layer downstream, not by call()
    const appState = context.getAppState()
    const attachments = await resolveAttachments(files, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: { caption, attachments },
    }
  },
  // The result the model reads back: a delivered-count line, then — only for
  // attachments that were uploaded — an indented path → file_uuid line each,
  // which is what lets later turns refer to an upload by its uuid.
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
