import type { ThemeName, ThemeSetting } from './theme.js'

/** The appearance in effect when nothing is stored: True Black — the
 *  authored palette on the pure-black ground family. The ONE owner of the
 *  default: the fresh-config factory, the provider's fallback, the picker's
 *  focused row, the ground owner's unreadable-config arm and the launcher
 *  splash's hand-mirror all follow it. A stored choice always outranks it,
 *  and a stored name outside the reachable vocabulary collapses onto it.
 *  It lives in this leaf module (no runtime imports) because the config
 *  schema reads it while its own module evaluates — theme.ts pulls the
 *  palette and accent graph and cannot be imported there. */
export const DEFAULT_THEME_SETTING = 'true-black' as const

/**
 * Resolves the `auto` theme setting to dark/light from the terminal's own
 * background colour rather than the OS appearance: a terminal configured
 * dark inside a light desktop must resolve dark, and vice versa.
 *
 * The resolution is cached at module level so callers resolve
 * synchronously. In this build the seed is the `COLORFGBG` environment
 * variable (else dark) for the whole process — there is no asynchronous
 * background-colour watcher.
 */

export type SystemTheme = 'dark' | 'light'

let cachedSystemTheme: SystemTheme | null = null

/**
 * `COLORFGBG` is `foreground;background`, sometimes with a middle field;
 * the LAST field is the background index. Best-effort — only some
 * terminals set it.
 */
function themeFromColorFgBg(value: string | undefined): SystemTheme | undefined {
  if (value === undefined || value === '') return undefined
  const fields = value.split(';')
  const last = fields[fields.length - 1]
  if (last === undefined || last === '') return undefined
  if (!/^\d+$/.test(last)) return undefined
  const background = parseInt(last, 10)
  if (background < 0 || background > 15) return undefined
  // Indices 0-6 and 8 are dark; 7 and 9-15 are light.
  if (background <= 6 || background === 8) return 'dark'
  return 'light'
}

export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === null) {
    cachedSystemTheme = themeFromColorFgBg(process.env.COLORFGBG) ?? 'dark'
  }
  return cachedSystemTheme
}

/** The setting itself, unless it is `auto` — then the cached/derived system theme. */
export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') return getSystemThemeName()
  return setting
}
