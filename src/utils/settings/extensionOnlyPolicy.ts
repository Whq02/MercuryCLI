import { CUSTOMIZATION_SURFACES } from './types.js'
import { getSettingsForSource } from './settings.js'

/**
 * The managed "customizations must come from extensions" lock: `true` locks
 * all four surfaces, an array locks the listed ones, absent locks nothing.
 * Read from the POLICY source only. "Locked" skips the user- and
 * project-level filesystem sources for that surface; managed content and an
 * approved extension's content always load (admin-authored by definition,
 * and an extension is gated by the operator's approval and the blocklist).
 */

export type CustomizationSurface = (typeof CUSTOMIZATION_SURFACES)[number]

export function isRestrictedToExtensionsOnly(surface: CustomizationSurface): boolean {
  const policy = getSettingsForSource('policySettings')
  const lock = policy?.strictExtensionOnlyCustomization
  if (lock === true) return true
  if (Array.isArray(lock)) return (lock as string[]).includes(surface)
  return false
}

// The last three spellings all exist because different subsystems tag
// built-ins differently. Everything else — user/project/local/flag
// settings, MCP, undefined — is untrusted.
const ADMIN_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  'extension',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
])

/** Per-item trust gate for content whose declared source tags admin authorship. */
export function isSourceAdminTrusted(source: string | undefined): boolean {
  if (source === undefined) return false
  return ADMIN_TRUSTED_SOURCES.has(source)
}
