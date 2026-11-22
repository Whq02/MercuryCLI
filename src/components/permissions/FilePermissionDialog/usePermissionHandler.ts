import { FILE_EDIT_TOOL_NAME } from '../../../constants/tools/fileEdit.js'
import { generateSuggestions } from '../../../utils/permissions/filesystem.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { FileOperationType, PermissionOption } from './permissionOptions.js'
import { unbuilt, type Unbuilt } from '../../../pi/holes.js'

export type PermissionHandlerParams = Unbuilt

type PermissionHandlerOptions = Unbuilt

export const PERMISSION_HANDLERS: Record<
  PermissionOption['type'],
  (params: PermissionHandlerParams, options?: PermissionHandlerOptions) => void
> = unbuilt('src/components/permissions/FilePermissionDialog/usePermissionHandler.ts:23')
