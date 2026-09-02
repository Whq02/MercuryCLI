import { resetSdkInitState } from '../../bootstrap/state.js'
import { untrustedWorkspaceHeadless } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getHooksFromOutsideCheckoutSources, getSettingsForSource, getSettings_DEPRECATED } from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { isRestrictedToExtensionsOnly } from '../settings/extensionOnlyPolicy.js'
import type { HooksSettings } from '../settings/types.js'

function computeEffectiveHooksConfig(): HooksSettings {
  const policy = getSettingsForSource('policySettings')
  if (policy?.disableAllHooks) return {}
  if (policy?.allowManagedHooksOnly) return policy.hooks ?? {}
  if (isRestrictedToExtensionsOnly('hooks')) return policy?.hooks ?? {}
  const merged = getSettings_DEPRECATED()
  if (merged?.disableAllHooks) return policy?.hooks ?? {}
  if (untrustedWorkspaceHeadless()) {
    logForDebugging(
      'hooks: untrusted workspace on a non-interactive road — checkout-delivered hooks are not loaded (boot interactively once here to trust this directory)',
    )
    return getHooksFromOutsideCheckoutSources()
  }
  return merged?.hooks ?? {}
}

export function shouldAllowManagedHooksOnly(): boolean {
  const policy = getSettingsForSource('policySettings')
  if (policy?.allowManagedHooksOnly) return true
  if (policy?.disableAllHooks) return false
  return getSettings_DEPRECATED()?.disableAllHooks === true
}

export function shouldDisableAllHooksIncludingManaged(): boolean {
  return getSettingsForSource('policySettings')?.disableAllHooks === true
}

let snapshot: HooksSettings | undefined

export function captureHooksConfigSnapshot(): void {
  snapshot = computeEffectiveHooksConfig()
}

export function updateHooksConfigSnapshot(): void {
  resetSettingsCache()
  captureHooksConfigSnapshot()
}

export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (snapshot === undefined) captureHooksConfigSnapshot()
  return snapshot ?? null
}

export function resetHooksConfigSnapshot(): void {
  snapshot = undefined
  resetSdkInitState()
}
