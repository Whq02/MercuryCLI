import * as React from 'react'
import { Text } from '../../../ink.js'
import { Dialog } from '../../design-system/Dialog.js'
import { Select } from '../../CustomSelect/select.js'
import { applyPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js'
import type { ToolPermissionContext } from '../../../Tool.js'

/**
 * Confirm-and-remove for one workspace directory. The removal is
 * session-scoped; the child applies it and pushes the updated context, then
 * notifies the parent (which owns the change-log line).
 */
export function RemoveWorkspaceDirectory({
  directoryPath,
  onRemove,
  onCancel,
  permissionContext,
  setPermissionContext,
}: {
  directoryPath: string
  onRemove: (path: string) => void
  onCancel: () => void
  permissionContext: ToolPermissionContext
  setPermissionContext: (context: ToolPermissionContext) => void
}): React.ReactNode {
  function handleChange(value: string): void {
    if (value !== 'yes') {
      onCancel()
      return
    }
    const updated = applyPermissionUpdate(permissionContext, {
      type: 'removeDirectories',
      directories: [directoryPath],
      destination: 'session',
    })
    setPermissionContext(updated)
    onRemove(directoryPath)
  }

  return (
    <Dialog title="Remove directory from workspace?" onCancel={onCancel} color="error">
      <Text bold>{directoryPath}</Text>
      <Text>Mercury will no longer have access to files in this directory.</Text>
      <Select
        options={[
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
        onChange={handleChange}
        onCancel={onCancel}
      />
    </Dialog>
  )
}
