import type { Command } from '../catalogue/commands.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../engine/connector/focusedConnector.js'
import { permissionModeTitle } from '../../permissions/rules/permissionMode.js'

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
