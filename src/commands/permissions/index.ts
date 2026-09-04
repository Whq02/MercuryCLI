import type { Command } from '../../commands.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: 'Shape the permission rules — what runs free, what asks first',
  currentValue: () =>
    hasFocusedSession() ? permissionModeTitle(getFocusedSessionConnector().permissionMode()) : undefined,
  load: () => import('./permissions.js'),
} satisfies Command

export default permissions
