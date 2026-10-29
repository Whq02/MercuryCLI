
import { colorize, type ColorType } from '../../ink/colorize.js'
import type { Color } from '../../ink/styles.js'
import { getTheme, type Theme, type ThemeName } from '../../utils/theme.js'

const RAW_COLOR_PREFIXES = ['rgb(', '#', 'ansi256(', 'ansi:'] as const

export function isRawColorValue(value: string): boolean {
  return RAW_COLOR_PREFIXES.some(prefix => value.startsWith(prefix))
}

export function resolveThemeColor(
  theme: Theme,
  value: string | undefined,
): Color | undefined {
  if (!value) return undefined
  if (isRawColorValue(value)) return value as Color
  return theme[value as keyof Theme] as Color | undefined
}

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
