import type { Command } from '../../commands.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'

const command = {
  type: 'local-jsx',
  name: 'authority',
  description: 'Capability gates & bypass — authority control (Mercury)',
  currentValue: () =>
    hasFocusedSession() ? permissionModeTitle(getFocusedSessionConnector().permissionMode()) : undefined,
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./authority.js'),
} satisfies Command

export default command
