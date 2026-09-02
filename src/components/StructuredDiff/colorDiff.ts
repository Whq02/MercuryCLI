
import {
  ColorDiff,
  ColorFile,
  getSyntaxTheme as nativeGetSyntaxTheme,
  type SyntaxTheme,
} from 'color-diff-napi'

export type ColorModuleUnavailableReason = 'env'

export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  if (getColorModuleUnavailableReason() !== null) return null
  const prototype = (ColorDiff as { prototype?: Record<string, unknown> }).prototype
  if (!prototype || typeof prototype['render'] !== 'function') return null
  return ColorDiff
}

export function expectColorFile(): typeof ColorFile | null {
  if (getColorModuleUnavailableReason() !== null) return null
  return ColorFile
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  if (getColorModuleUnavailableReason() !== null) return null
  return nativeGetSyntaxTheme(themeName)
}
