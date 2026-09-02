import { resetSdkInitState } from '../../bootstrap/state.js'
import { untrustedWorkspaceHeadless } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getHooksFromOutsideCheckoutSources, getSettingsForSource, getSettings_DEPRECATED } from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { isRestrictedToExtensionsOnly } from '../settings/extensionOnlyPolicy.js'
import type { HooksSettings } from '../settings/types.js'

/**
 * Startup snapshot of the effective hooks configuration under the policy
 * ladder. First match wins:
 *
 *  1. policy settings disable ALL hooks — no hooks at all, managed included;
 *  2. policy settings request managed-only — only the policy's own hooks;
 *  3. a extensions-only customisation restriction covers the hooks facet — only
 *     the policy's own hooks (extension hooks arrive through a separate
 *     registered channel and are unaffected; agent frontmatter hooks are
 *     gated at registration time by the agent's source, so a blanket
 *     execution-time block here would over-kill extension agents' hooks);
 *  4. the MERGED settings disable all hooks — only the policy's own hooks,
 *     because non-managed settings cannot disable managed ones;
 *  5. an untrusted workspace on the headless road — the outside-checkout
 *     sources only (FC-144; see the comment at the arm);
 *  6. otherwise the merged hooks from every source.
 */
function computeEffectiveHooksConfig(): HooksSettings {
  const policy = getSettingsForSource('policySettings')
  if (policy?.disableAllHooks) return {}
  if (policy?.allowManagedHooksOnly) return policy.hooks ?? {}
  if (isRestrictedToExtensionsOnly('hooks')) return policy?.hooks ?? {}
  const merged = getSettings_DEPRECATED()
  if (merged?.disableAllHooks) return policy?.hooks ?? {}
  // Untrusted workspace on the headless road (FC-144): hooks are commands a
  // settings file asked Mercury to run, and the checkout's own files
  // (project AND the committable settings.local.json) must not get to run
  // anything in a directory the operator never trusted. The interactive
  // road's blanket execution-time gate has no headless analog — the dialog
  // never arrives — so the snapshot composes from the outside-checkout
  // sources instead. SDK-supplied hooks ride other channels and are the
  // embedder's own; they are untouched.
  if (untrustedWorkspaceHeadless()) {
    logForDebugging(
      'hooks: untrusted workspace on a non-interactive road — checkout-delivered hooks are not loaded (boot interactively once here to trust this directory)',
    )
    return getHooksFromOutsideCheckoutSources()
  }
  return merged?.hooks ?? {}
}

/**
 * True when policy requests managed-only, OR when non-managed settings
 * disable all hooks while policy does not — that combination is effectively
 * managed-only at execution time.
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policy = getSettingsForSource('policySettings')
  if (policy?.allowManagedHooksOnly) return true
  if (policy?.disableAllHooks) return false
  return getSettings_DEPRECATED()?.disableAllHooks === true
}

/** True only when the policy settings themselves disable all hooks. */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return getSettingsForSource('policySettings')?.disableAllHooks === true
}

// undefined = never captured; a captured snapshot is always an object
// (the empty/blocked ladder arms snapshot an empty object).
let snapshot: HooksSettings | undefined

export function captureHooksConfigSnapshot(): void {
  snapshot = computeEffectiveHooksConfig()
}

/**
 * Re-capture after a settings change. The cache reset must come first: an
 * externally edited settings file may not have crossed the file watcher's
 * stability threshold yet, and re-capturing through the cache would
 * snapshot stale bytes.
 */
export function updateHooksConfigSnapshot(): void {
  resetSettingsCache()
  captureHooksConfigSnapshot()
}

/** A read with no snapshot yet captures one lazily. */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (snapshot === undefined) captureHooksConfigSnapshot()
  return snapshot ?? null
}

/**
 * The bootstrap reset entry point: clears the snapshot (back to
 * never-captured) and resets the SDK programmatic-init state with it.
 */
export function resetHooksConfigSnapshot(): void {
  snapshot = undefined
  resetSdkInitState()
}
