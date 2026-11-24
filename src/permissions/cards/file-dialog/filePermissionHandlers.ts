import { EDIT_TOOL_NAME } from '../../../tools/kit/names/fileEdit.js'
import { generateSuggestions } from '../../rules/filesystem.js'
import type { ToolPermissionContext } from '../../../tools/kit/tool.js'
import type { PermissionUpdate } from '../../rules/permissions.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { FileOperationType, PermissionOption } from './permissionOptions.js'

export type PermissionHandlerParams = {
  path: string | null
  toolUseConfirm: ToolUseConfirm
  toolPermissionContext: ToolPermissionContext
  operationType: FileOperationType
  onDone: () => void
  onReject: () => void
}

type PermissionHandlerOptions = {
  feedback?: string
  scope?: 'config-home' | 'global-config-home'
  pattern?: string
}

export const PERMISSION_HANDLERS: Record<
  PermissionOption['type'],
  (params: PermissionHandlerParams, options?: PermissionHandlerOptions) => void
> = {
  'accept-once': ({ toolUseConfirm, onDone }, options) => {
    onDone()
    toolUseConfirm.onAllow(toolUseConfirm.input, [], options?.feedback)
  },
  'accept-session': (
    { path, toolUseConfirm, toolPermissionContext, operationType, onDone },
    options,
  ) => {
    onDone()
    const updates: PermissionUpdate[] =
      options?.scope !== undefined && options?.pattern !== undefined
        ? [
            {
              type: 'addRules',
              rules: [
                {
                  toolName: EDIT_TOOL_NAME,
                  ruleContent: options.pattern,
                },
              ],
              behavior: 'allow',
              destination: 'session',
            },
          ]
        : path !== null
          ? generateSuggestions(path, operationType, toolPermissionContext)
          : []
    toolUseConfirm.onAllow(toolUseConfirm.input, updates)
  },
  reject: ({ toolUseConfirm, onDone, onReject }, options) => {
    onDone()
    onReject()
    toolUseConfirm.onReject(options?.feedback)
  },
}
