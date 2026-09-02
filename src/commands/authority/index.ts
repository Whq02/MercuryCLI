import type { Command } from '../../commands.js'
import {
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

// /authority — Mercury capability/authority control (MercuryPermissionsPanel).
// The base /permissions rule editor stays as-is; this is the warm-ink
// capability-gate + bypass surface. Bypass lights MercuryFrame's ▸▸ badge.
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
