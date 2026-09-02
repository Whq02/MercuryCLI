import type { Command } from '../../commands.js'
import {
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: 'Shape the permission rules — what runs free, what asks first',
  currentValue: live =>
    live.permissionMode === undefined
      ? undefined
      : permissionModeTitle(live.permissionMode as PermissionMode),
  load: () => import('./permissions.js'),
} satisfies Command

export default permissions
