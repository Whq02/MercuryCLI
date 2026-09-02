
import {
  getIsNonInteractiveSession,
  isAssistantFamilyAvailable,
  isAssistantSessionActive,
  getUserMsgOptIn,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/featureGates.js'
import { buildTool } from '../../Tool.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { z } from 'zod'
import {
  resolveAttachments,
  validateAttachmentPaths,
  type ResolvedAttachment,
} from './attachments.js'
import { BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME } from './prompt.js'
import { resolveBriefToolPrompt } from './promptSelect.js'
import * as UI from './UI.js'

const RESULT_SIZE_CAP = 100_000

const BRIEF_FEATURE_GATE = 'mercury_assistant_brief'
const BRIEF_GATE_REFRESH_MS = 5 * 60_000

export function isBriefEntitled(): boolean {
  if (flagEnv('MERCURY_BRIEF') === '0') return false
  const explicitBriefOptIn =
    getUserMsgOptIn() ||
    flagEnv('MERCURY_BRIEF') === '1' ||
    isAssistantSessionActive()
  if (getIsNonInteractiveSession() && !explicitBriefOptIn) {
    return false
  }
  return (
    isAssistantFamilyAvailable() ||
    isEnvTruthy(flagEnv('MERCURY_BRIEF')) ||
    getFeatureValue_CACHED_WITH_REFRESH(
      BRIEF_FEATURE_GATE,
      true,
      BRIEF_GATE_REFRESH_MS,
    )
  )
}

export function isBriefEnabled(): boolean {
  if (!isBriefEntitled()) return false
  const awayOrOptIn =
    isAssistantSessionActive() ||
    getUserMsgOptIn() ||
    isEnvTruthy(flagEnv('MERCURY_BRIEF'))
  return awayOrOptIn
}

const inputSchema = z
  .object({
    message: z.string().describe('The message (markdown supported)'),
    attachments: z
      .array(z.string())
      .optional()
      .describe('File paths to attach, absolute or cwd-relative'),
    status: z
      .enum(['normal', 'proactive'])
      .describe(
        "'normal' when replying to something the user just said; 'proactive' when surfacing something unrequested that needs to be seen now (work finished while nobody was watching, an obstacle needing a decision, an unasked-for status change). Downstream routing consumes this — set it honestly.",
      ),
  })
  .strict()

export type Input = z.infer<typeof inputSchema>

export type Output = {
  message: string
  attachments?: ResolvedAttachment[]
  sentAt?: string
}

export const BriefTool = buildTool({
  name: BRIEF_TOOL_NAME,
  aliases: [LEGACY_BRIEF_TOOL_NAME],
  inputSchema,
  maxResultSizeChars: RESULT_SIZE_CAP,
  searchHint: 'send the user a message through the dedicated channel',
  async description() {
    return 'Put a progress note in front of the user'
  },
  async prompt() {
    return resolveBriefToolPrompt()
  },
  isEnabled(): boolean {
    return isBriefEnabled()
  },
  isReadOnly(): boolean {
    return true
  },
  isConcurrencySafe(): boolean {
    return true
  },
  userFacingName(): string {
    return ''
  },
  toAutoClassifierInput(input: Input): string {
    return input.message
  },
  async validateInput(input: Input) {
    if (!input.attachments || input.attachments.length === 0) {
      return { result: true as const }
    }
    return validateAttachmentPaths(input.attachments)
  },
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input, context) {
    const sentAt = new Date().toISOString()
    if (!input.attachments || input.attachments.length === 0) {
      return { data: { message: input.message, sentAt } as Output }
    }
    const attachments = await resolveAttachments(input.attachments, {
      replBridgeEnabled: false,
      signal: context.abortController.signal,
    })
    return {
      data: { message: input.message, attachments, sentAt } as Output,
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const count = output.attachments?.length ?? 0
    const suffix =
      count > 0 ? ` (${count} attachment${count === 1 ? '' : 's'})` : ''
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `Message delivered to the user${suffix}.`,
    }
  },
  extractSearchText(output: Output): string {
    return output.message
  },
  renderToolUseMessage: UI.renderToolUseMessage,
  renderToolResultMessage: UI.renderToolResultMessage,
})
