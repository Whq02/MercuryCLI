#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'theme-roster-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_THEME_PIN

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)

const themeMod = await import('../../src/screen/theme/theme.js')
const tokensMod = await import('../../src/screen/theme/mercuryTokens.js')
const systemMod = await import('../../src/screen/theme/systemTheme.js')

const RETIRED = ['light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi'] as const
const UNKNOWN = 'not-a-theme'

section('§1 the roster is exactly the three appearances')
{
  check(
    'THEME_NAMES equals [dark, true-black, mono]',
    JSON.stringify(themeMod.THEME_NAMES) === JSON.stringify(['dark', 'true-black', 'mono']),
    `${JSON.stringify(themeMod.THEME_NAMES)}; THEME_NAMES in src/screen/theme/theme.ts must list exactly dark, true-black, mono`,
  )
  check(
    'the reachable settings equal the roster (every chooser offers exactly it)',
    JSON.stringify(themeMod.REACHABLE_THEME_SETTINGS) === JSON.stringify(themeMod.THEME_NAMES),
    `${JSON.stringify(themeMod.REACHABLE_THEME_SETTINGS)}; make REACHABLE_THEME_SETTINGS in src/screen/theme/theme.ts list the same names as THEME_NAMES`,
  )
  check(
    'the settings vocabulary is auto first, then the roster',
    JSON.stringify(themeMod.THEME_SETTINGS) === JSON.stringify(['auto', 'dark', 'true-black', 'mono']),
    `${JSON.stringify(themeMod.THEME_SETTINGS)}; THEME_SETTINGS in src/screen/theme/theme.ts must be auto followed by THEME_NAMES`,
  )
  check(
    'the one default owner names True Black',
    systemMod.DEFAULT_THEME_SETTING === 'true-black',
    `got ${String(systemMod.DEFAULT_THEME_SETTING)}; DEFAULT_THEME_SETTING in src/screen/theme/systemTheme.ts must be true-black`,
  )
}

section('§2 the chooser rows equal the roster')
{
}

section('§3 no palette or token table for another family exists in src')
{
}

section('§4 a retired name resolves exactly as an unknown name does')
{
  const { getSyntaxTheme } = await import('../../src/screen/structured-diff/colorDiff.js')
  const unknownTheme = JSON.stringify(themeMod.getTheme(UNKNOWN))
  const unknownTokens = JSON.stringify(tokensMod.resolveMercuryTokens(UNKNOWN, '#DD4444'))
  const unknownSyntax = JSON.stringify(getSyntaxTheme(UNKNOWN))
  for (const name of RETIRED) {
    check(
      `${name}: getTheme resolves as the unknown name does`,
      JSON.stringify(themeMod.getTheme(name)) === unknownTheme,
      'getTheme in src/screen/theme/theme.ts must send a retired name to the same fallback as an unknown name',
    )
    check(
      `${name}: adaptive tokens resolve as the unknown name's do`,
      JSON.stringify(tokensMod.resolveMercuryTokens(name, '#DD4444')) === unknownTokens,
      'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must send a retired name to the same fallback as an unknown name',
    )
    check(
      `${name}: the ground gate answers as it does for the unknown name`,
      tokensMod.isDarkThemeFamily(name) === tokensMod.isDarkThemeFamily(UNKNOWN),
      'isDarkThemeFamily in src/screen/theme/mercuryTokens.ts must answer a retired name as it answers an unknown name',
    )
    check(
      `${name}: the syntax theme resolves as the unknown name's does`,
      JSON.stringify(getSyntaxTheme(name)) === unknownSyntax,
      'getSyntaxTheme in src/screen/structured-diff/colorDiff.ts must resolve a retired name as it resolves an unknown name',
    )
  }
}

section('§5 a stored retired name steers nothing, exactly as a stored unknown name')
{
  const cfg = await import('../../src/platform/settings/config.js')
  const provider = await import('../../src/screen/theme/ThemeProvider.js')
  const { DEFAULT_THEME_SETTING } = systemMod
  const storedAtStart = cfg.getGlobalConfig().theme
  delete process.env.MERCURY_THEME_PIN
  for (const name of [...RETIRED, UNKNOWN]) {
    cfg.saveGlobalConfig(c => ({ ...c, theme: name }))
    check(
      `stored ${name}: the resolution owner answers the default, like any unknown name`,
      provider.currentStoredThemeSetting() === DEFAULT_THEME_SETTING,
      `got ${provider.currentStoredThemeSetting()}; currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must fall back to DEFAULT_THEME_SETTING for a stored name outside the roster`,
    )
  }
  cfg.saveGlobalConfig(c => ({ ...c, theme: storedAtStart }))
  process.env.MERCURY_THEME_PIN = 'dark-ansi'
  check(
    'a retired name through the pin is ignored like any invalid pin (the stored value stands)',
    provider.currentStoredThemeSetting() === storedAtStart,
    `got ${provider.currentStoredThemeSetting()}; currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must ignore a MERCURY_THEME_PIN outside the roster`,
  )
  process.env.MERCURY_THEME_PIN = 'dark'
  check(
    'a living appearance through the pin pins this process',
    provider.currentStoredThemeSetting() === 'dark',
    `got ${provider.currentStoredThemeSetting()}; currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must honour a valid MERCURY_THEME_PIN`,
  )
  delete process.env.MERCURY_THEME_PIN
  check(
    'the config under test is restored',
    cfg.getGlobalConfig().theme === storedAtStart,
    'saveGlobalConfig in src/platform/settings/config.ts did not write the stored theme back',
  )
}

section('§6 auto resolves to the oasis appearance on every terminal')
{
  check(
    'resolveThemeSetting(auto) is the oasis appearance',
    systemMod.resolveThemeSetting('auto') === 'dark',
    `got ${systemMod.resolveThemeSetting('auto')}; resolveThemeSetting in src/screen/theme/systemTheme.ts must answer dark for auto`,
  )
  check(
    'the system-theme name is the oasis appearance',
    systemMod.getSystemThemeName() === 'dark',
    `got ${systemMod.getSystemThemeName()}; getSystemThemeName in src/screen/theme/systemTheme.ts must answer dark`,
  )
  const cfg = await import('../../src/platform/settings/config.js')
  const provider = await import('../../src/screen/theme/ThemeProvider.js')
  const storedAtStart = cfg.getGlobalConfig().theme
  cfg.saveGlobalConfig(c => ({ ...c, theme: 'auto' }))
  check(
    'a stored auto keeps working: the resolution owner answers the default appearance',
    provider.currentStoredThemeSetting() === systemMod.DEFAULT_THEME_SETTING,
    `got ${provider.currentStoredThemeSetting()}; currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must answer DEFAULT_THEME_SETTING for a stored auto`,
  )
  cfg.saveGlobalConfig(c => ({ ...c, theme: storedAtStart }))
}

section('§7 the stored-grid census carries only living families')
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'design-system/live/manifest.json'), 'utf8')) as {
    entries: Array<{ id: string; theme: string; gridPath: string }>
  }
  const roster = new Set<string>(themeMod.THEME_NAMES)
  const retired = manifest.entries.filter(e => !roster.has(e.theme)).map(e => e.id)
  check('every manifest entry records a living appearance', retired.length === 0, `${retired.join(', ')}; regenerate or remove these entries in design-system/live/manifest.json`)
  const grids = readdirSync(join(ROOT, 'design-system/live/grids')).filter(f => f.endsWith('.grid.json')).sort()
  const named = manifest.entries.map(e => e.gridPath.replace(/^grids\//, '')).sort()
  check(
    'the grids directory holds exactly the manifest entries',
    JSON.stringify(grids) === JSON.stringify(named),
    `${grids.length} grids vs ${named.length} entries; make design-system/live/grids and design-system/live/manifest.json list the same grid files`,
  )
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\ntheme roster: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
