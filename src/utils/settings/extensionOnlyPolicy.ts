import { CUSTOMIZATION_SURFACES } from './types.js'
import { getSettingsForSource } from './settings.js'


export type CustomizationSurface = (typeof CUSTOMIZATION_SURFACES)[number]

export function isRestrictedToExtensionsOnly(surface: CustomizationSurface): boolean {
  const policy = getSettingsForSource('policySettings')
  const lock = policy?.strictExtensionOnlyCustomization
  if (lock === true) return true
  if (Array.isArray(lock)) return (lock as string[]).includes(surface)
  return false
}

const ADMIN_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  'extension',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
])

export function isSourceAdminTrusted(source: string | undefined): boolean {
  if (source === undefined) return false
  return ADMIN_TRUSTED_SOURCES.has(source)
}
