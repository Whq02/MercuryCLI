import { clearRegisteredHooks } from '../../bootstrap/state.js'
import { untrustedWorkspaceHeadless } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getHooksFromOutsideCheckoutSources, getSettingsForSource, getInitialSettings } from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { isRestrictedToExtensionsOnly } from '../settings/extensionOnlyPolicy.js'
import type { HooksSettings } from '../settings/types.js'

function computeEffectiveHooksConfig(): HooksSettings {
  const policy = getSettingsForSource('policySettings')
  if (policy?.events?.disabled) return {}
  if (policy?.events?.managedOnly) return policy.events?.hooks ?? {}
  if (isRestrictedToExtensionsOnly('hooks')) return policy?.events?.hooks ?? {}
  const merged = getInitialSettings()
  if (merged?.events?.disabled) return policy?.events?.hooks ?? {}
  if (untrustedWorkspaceHeadless()) {
    logForDebugging(
      'hooks: untrusted workspace on a non-interactive road — checkout-delivered hooks are not loaded (boot interactively once here to trust this directory)',
    )
    return getHooksFromOutsideCheckoutSources()
  }
  return merged?.events?.hooks ?? {}
}

export function shouldAllowManagedHooksOnly(): boolean {
  const policy = getSettingsForSource('policySettings')
  if (policy?.events?.managedOnly) return true
  if (policy?.events?.disabled) return false
  return getInitialSettings()?.events?.disabled === true
}

export function shouldDisableAllHooksIncludingManaged(): boolean {
  return getSettingsForSource('policySettings')?.events?.disabled === true
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
  clearRegisteredHooks()
}
