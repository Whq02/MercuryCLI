import type { Command } from '../../commands.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'

const permissions: Command = {
  type: 'local-jsx',
  name: 'permissions',
  description: 'Shape the permission rules — what runs free, what asks first',
  currentValue: () => {
    if (!hasFocusedSession()) return undefined
    const mode = getFocusedSessionConnector().permissionMode()
    return mode === null ? undefined : permissionModeTitle(mode)
  },
  load: () => import('./permissions.js'),
}

export default permissions
