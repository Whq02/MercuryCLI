import * as React from 'react'
import { useMemo } from 'react'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { expandPath } from '../../../utils/path.js'
import { isSqliteRowTarget, SQLITE_ROW_NOT_CHECKPOINTED } from '../../../tools/FileWriteTool/structuredTargets.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { WorkerBadgeProps } from '../WorkerBadge.js'
import type { FileOperationType, ToolInput } from './permissionOptions.js'
import { useFilePermissionDialog } from './useFilePermissionDialog.js'
import { passedOver } from '../../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type FilePermissionDialogProps<T extends ToolInput> = Unbuilt

export function resolveSymlinkTarget(path: string | null): string | undefined {
  if (path === null || isRemotePath(path)) return undefined
  try {
    const expanded = expandPath(path)
    if (!lstatSync(expanded).isSymbolicLink()) return undefined
    try {
      return realpathSync(expanded)
    } catch {
      return resolve(dirname(expanded), readlinkSync(expanded))
    }
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function FilePermissionDialog<T extends ToolInput>(arg0: FilePermissionDialogProps<T>): React.ReactNode {
  return notBuilt('src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx:50')
}
