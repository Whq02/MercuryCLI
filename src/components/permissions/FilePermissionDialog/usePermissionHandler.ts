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
    params.onDone()
    params.toolUseConfirm.onAllow(params.toolUseConfirm.input, [], options?.feedback)
  },
  'accept-session': (params, options) => {
    logFileDecision(params, 'accept')
    params.onDone()
    if (options?.scope) {
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
