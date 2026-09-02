import type { ThemeName, ThemeSetting } from './theme.js'


export type SystemTheme = 'dark' | 'light'

let cachedSystemTheme: SystemTheme | null = null

function themeFromColorFgBg(value: string | undefined): SystemTheme | undefined {
  if (value === undefined || value === '') return undefined
  const fields = value.split(';')
  const last = fields[fields.length - 1]
  if (last === undefined || last === '') return undefined
  if (!/^\d+$/.test(last)) return undefined
  const background = parseInt(last, 10)
  if (background < 0 || background > 15) return undefined
  if (background <= 6 || background === 8) return 'dark'
  return 'light'
}

export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === null) {
    cachedSystemTheme = themeFromColorFgBg(process.env.COLORFGBG) ?? 'dark'
  }
  return cachedSystemTheme
}

export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') return getSystemThemeName()
  return setting
}
