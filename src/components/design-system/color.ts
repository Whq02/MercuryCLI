// The curried theme-aware colouriser for string output, plus the raw-colour
// value grammar shared by the themed primitives. Role lookup happens against
// the named theme; raw values bypass it entirely. The legacy role alias map
// is deliberately NOT applied here (it is a text-primitive input surface).

import { colorize, type ColorType } from '../../ink/colorize.js'
import type { Color } from '../../ink/styles.js'
import { getTheme, type Theme, type ThemeName } from '../../utils/theme.js'

/** The recognized raw-colour value forms (contract data): anything beginning
 *  with one of these bypasses theme-role lookup across the theming
 *  primitives and this colouriser. */
const RAW_COLOR_PREFIXES = ['rgb(', '#', 'ansi256(', 'ansi:'] as const

export function isRawColorValue(value: string): boolean {
  return RAW_COLOR_PREFIXES.some(prefix => value.startsWith(prefix))
}

/** Resolve a role-or-raw colour against a resolved theme object: raw values
 *  pass through, anything else is looked up as a role. An unknown role (or
 *  an absent/empty value) yields undefined — "no colour", never a throw.
 *  The return is typed as the renderer's Color: theme values are authored
 *  in the raw grammar, and the renderer's colouriser returns unknown forms
 *  untouched, so the widening is runtime-safe. */
export function resolveThemeColor(
  theme: Theme,
  value: string | undefined,
): Color | undefined {
  if (!value) return undefined
  if (isRawColorValue(value)) return value as Color
  return theme[value as keyof Theme] as Color | undefined
}

/**
 * Curried string colouriser: `color(value, themeName)(text)`. An undefined
 * colour returns the text unchanged; raw values bypass role lookup; anything
 * else resolves as a role in the named theme before delegating to the
 * renderer's colouriser.
 */
export function color(
  colorKeyOrValue: keyof Theme | (string & {}) | undefined,
  themeName: ThemeName,
  type: ColorType = 'foreground',
): (text: string) => string {
  return (text: string): string => {
    if (colorKeyOrValue === undefined) return text
    const resolved = isRawColorValue(colorKeyOrValue)
      ? colorKeyOrValue
      : getTheme(themeName)[colorKeyOrValue as keyof Theme]
    return colorize(text, resolved, type)
  }
}
