import type { Command } from '../../commands.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'

const command = {
  type: 'local-jsx',
  name: 'authority',
  description: 'Capability gates & bypass — authority control (Mercury)',
  currentValue: () => {
    if (!hasFocusedSession()) return undefined
    const mode = getFocusedSessionConnector().permissionMode()
    return mode === null ? undefined : permissionModeTitle(mode)
  },
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./authority.js'),
} satisfies Command

export default command
