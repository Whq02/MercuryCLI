import { getSettingsForSource } from './settings.js'
import type { CUSTOMIZATION_SURFACES } from './settingsSchema.js'

type CustomizationSurface = (typeof CUSTOMIZATION_SURFACES)[number]

const ADMIN_TRUSTED_SOURCES: readonly string[] = [
  'extension',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
]

export function isRestrictedToExtensionsOnly(surface: CustomizationSurface): boolean {
  const exclusive = getSettingsForSource('policySettings')?.extensions?.exclusive
  if (exclusive === true) return true
  if (Array.isArray(exclusive)) return exclusive.includes(surface)
  return false
}

export function isSourceAdminTrusted(source: string | undefined): boolean {
  return source !== undefined && ADMIN_TRUSTED_SOURCES.includes(source)
}
