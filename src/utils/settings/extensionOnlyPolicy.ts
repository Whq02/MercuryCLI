import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type CustomizationSurface = Unbuilt

export function isRestrictedToExtensionsOnly(surface: CustomizationSurface): boolean {
  return notBuilt('src/utils/settings/extensionOnlyPolicy.ts:7')
}

export function isSourceAdminTrusted(source: string | undefined): boolean {
  return notBuilt('src/utils/settings/extensionOnlyPolicy.ts:23')
}
