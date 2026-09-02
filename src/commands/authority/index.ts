import type { Command } from '../../commands.js'
import {
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

const command = {
  type: 'local-jsx',
  name: 'authority',
  description: 'Capability gates & bypass — authority control (Mercury)',
  currentValue: live =>
    live.permissionMode === undefined
      ? undefined
      : permissionModeTitle(live.permissionMode as PermissionMode),
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./authority.js'),
} satisfies Command

export default command
