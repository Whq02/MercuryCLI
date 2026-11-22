import type { Command } from '../../commands.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const permissions: Unbuilt = unbuilt('src/commands/permissions/index.ts:5')

export default permissions
