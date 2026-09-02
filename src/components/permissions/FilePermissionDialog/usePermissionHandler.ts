/**
 * The three terminal file-decision handlers, addressable as a record keyed by
 * the option type. The request object handed to them is the dialog's LOCAL
 * wrapper whose `input` is the parsed / IDE-modified input — the shared
 * request object is never mutated, so a second dispatch from the same dialog
 * cannot double-wrap.
 */
import { env } from '../../../utils/env.js'
import { logUnaryEvent, type CompletionType } from '../../../utils/unaryLogging.js'
import { FILE_EDIT_TOOL_NAME } from '../../../tools/FileEditTool/constants.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from '../../../tools/FileEditTool/constants.js'
import { generateSuggestions } from '../../../utils/permissions/filesystem.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { FileOperationType, PermissionOption } from './permissionOptions.js'

export type PermissionHandlerParams = {
  messageId: string
  path: string | null
  toolUseConfirm: ToolUseConfirm
  toolPermissionContext: ToolPermissionContext
  onDone: () => void
  onReject: () => void
  completionType: CompletionType
  languageName: string | Promise<string>
  operationType: FileOperationType
}

export type PermissionHandlerOptions = {
  hasFeedback?: boolean
  feedback?: string
  enteredFeedbackMode?: boolean
  scope?: 'claude-folder' | 'global-claude-folder'
  pattern?: string
}

/** The file-card emitter: the card's language (possibly a promise), the raw
 *  process platform, and had-feedback only on the reject path. */
function logFileDecision(
  params: PermissionHandlerParams,
  event: 'accept' | 'reject',
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    event,
    completion_type: params.completionType,
    metadata: {
      language_name: params.languageName,
      message_id: params.messageId,
      platform: env.platform,
      ...(event === 'reject' ? { hasFeedback: hasFeedback ?? false } : {}),
    },
  })
}

export const PERMISSION_HANDLERS: Record<
  PermissionOption['type'],
  (params: PermissionHandlerParams, options?: PermissionHandlerOptions) => void
> = {
  'accept-once': (params, options) => {
    logFileDecision(params, 'accept')
    // Dismiss happens before allow.
    params.onDone()
    params.toolUseConfirm.onAllow(params.toolUseConfirm.input, [], options?.feedback)
  },
  'accept-session': (params, options) => {
    logFileDecision(params, 'accept')
    params.onDone()
    if (options?.scope) {
      // Config-estate approval: one SESSION-destined allow-rule for the Edit
      // tool, with the estate pattern the option carried — or the frozen
      // legacy spellings when none was supplied.
      const fallback =
        options.scope === 'global-claude-folder'
          ? GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN
          : CLAUDE_FOLDER_PERMISSION_PATTERN
      const updates: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: FILE_EDIT_TOOL_NAME, ruleContent: options.pattern ?? fallback }],
          behavior: 'allow',
          destination: 'session',
        },
      ]
      params.toolUseConfirm.onAllow(params.toolUseConfirm.input, updates)
      return
    }
    const updates =
      params.path !== null
        ? generateSuggestions(params.path, params.operationType, params.toolPermissionContext)
        : []
    params.toolUseConfirm.onAllow(params.toolUseConfirm.input, updates)
  },
  reject: (params, options) => {
    logFileDecision(params, 'reject', options?.hasFeedback)
    params.onDone()
    params.onReject()
    params.toolUseConfirm.onReject(options?.feedback)
  },
}
