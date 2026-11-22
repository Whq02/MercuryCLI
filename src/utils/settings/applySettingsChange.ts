import type { AppState } from '../../state/AppStateStore.js'
import { refreshHooksSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import {
  createSovereignDisabledContext,
  isSovereignDisabled,
  stripDangerousPermissionsForFlow,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'
import { notBuilt } from '../../pi/holes.js'

export function applySettingsChange(
  source: SettingSource,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  return notBuilt('src/utils/settings/applySettingsChange.ts:13')
}
