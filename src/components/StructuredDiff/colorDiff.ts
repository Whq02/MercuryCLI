// Availability gate for the syntax-colour module (adapter-seam). The
// module is imported through the bare specifier `color-diff-napi` (contract
// data — a build alias to the pure-TS renderer); this file is the alias's
// ONLY importer in src/. (settings.syntaxHighlightingDisabled is the off
// switch — no env kill; the module itself is always linkable.)

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

/** The diff renderer — null when disabled, and null when the linked module
 *  cannot actually render (its prototype carries no render function), so
 *  consumers fall back cleanly rather than throwing at call time. */
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
