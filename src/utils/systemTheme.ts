import type { ThemeName, ThemeSetting } from './theme.js'

export const DEFAULT_THEME_SETTING = 'true-black' as const

export type SystemTheme = 'dark'

export function getSystemThemeName(): SystemTheme {
  return 'dark'
}

export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') return getSystemThemeName()
  return setting
}
