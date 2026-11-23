import {
  ColorDiff,
  ColorFile,
  getSyntaxTheme as getNativeSyntaxTheme,
  type SyntaxTheme,
} from 'color-diff-napi'

type ColorModuleUnavailableReason = string

export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  return null
}

export function expectColorDiff(): typeof ColorDiff | null {
  if (getColorModuleUnavailableReason() !== null) return null
  return typeof ColorDiff.prototype.render === 'function' ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  if (getColorModuleUnavailableReason() !== null) return null
  return ColorFile
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  if (getColorModuleUnavailableReason() !== null) return null
  return getNativeSyntaxTheme(themeName)
}
