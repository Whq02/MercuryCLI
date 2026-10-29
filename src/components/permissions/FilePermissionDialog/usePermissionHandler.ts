import { FILE_EDIT_TOOL_NAME } from '../../../tools/FileEditTool/constants.js'
import { generateSuggestions } from '../../../utils/permissions/filesystem.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { FileOperationType, PermissionOption } from './permissionOptions.js'

export type PermissionHandlerParams = {
  path: string | null
  toolUseConfirm: ToolUseConfirm
  toolPermissionContext: ToolPermissionContext
  onDone: () => void
  onReject: () => void
  operationType: FileOperationType
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
  'accept-once': (params, options) => {
    params.onDone()
    params.toolUseConfirm.onAllow(params.toolUseConfirm.input, [], options?.feedback)
  },
  'accept-session': (params, options) => {
    params.onDone()
    if (options?.scope !== undefined && options.pattern !== undefined) {
      const updates: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: FILE_EDIT_TOOL_NAME, ruleContent: options.pattern }],
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
    params.onDone()
    params.onReject()
    params.toolUseConfirm.onReject(options?.feedback)
  },
}
