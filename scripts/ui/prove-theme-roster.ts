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

const themeMod = await import('../../src/utils/theme.js')
const tokensMod = await import('../../src/utils/mercuryTokens.js')
const systemMod = await import('../../src/utils/systemTheme.js')

const RETIRED = ['light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi'] as const
const UNKNOWN = 'not-a-theme'

section('§1 the roster is exactly the two appearances')
{
  check(
    'THEME_NAMES equals [dark, true-black]',
    JSON.stringify(themeMod.THEME_NAMES) === JSON.stringify(['dark', 'true-black']),
    JSON.stringify(themeMod.THEME_NAMES),
  )
  check(
    'the reachable settings equal the roster (every chooser offers exactly it)',
    JSON.stringify(themeMod.REACHABLE_THEME_SETTINGS) === JSON.stringify(themeMod.THEME_NAMES),
    JSON.stringify(themeMod.REACHABLE_THEME_SETTINGS),
  )
  check(
    'the settings vocabulary is auto first, then the roster',
    JSON.stringify(themeMod.THEME_SETTINGS) === JSON.stringify(['auto', 'dark', 'true-black']),
    JSON.stringify(themeMod.THEME_SETTINGS),
  )
  check('the one default owner names True Black', systemMod.DEFAULT_THEME_SETTING === 'true-black')
}

section('§2 the chooser rows equal the roster')
{
  const picker = readFileSync(join(ROOT, 'src/components/ThemePicker.tsx'), 'utf8')
  check(
    'the theme picker maps the reachable roster and labels the two appearances',
    picker.includes('REACHABLE_THEME_SETTINGS.map') &&
      picker.includes("dark: 'Oasis dark'") &&
      picker.includes("'true-black': 'True Black'"),
  )
  const onboarding = readFileSync(join(ROOT, 'src/components/Onboarding.tsx'), 'utf8')
  check(
    'the first-run fitting offers the two appearances and no third row',
    onboarding.includes("value: 'dark'") && onboarding.includes("value: 'true-black'") && !onboarding.includes("value: 'auto'"),
  )
  const config = readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8')
  const labels = /const THEME_LABELS: Record<string, string> = \{([\s\S]*?)\}/.exec(config)?.[1] ?? ''
  check(
    'the /config theme labels carry no retired family',
    !RETIRED.some(name => labels.includes(`'${name}'`)) && !/daltonized|ANSI only/.test(labels),
    labels.trim().slice(0, 200),
  )
}

section('§3 no palette or token table for another family exists in src')
{
  const FORBIDDEN = /daltonized|light-ansi|dark-ansi|LIGHT_ANSI|DARK_ANSI|LIGHT_DALTONIZED|DARK_DALTONIZED|ANSI_SCOPES|isDaltonized|roleStructureOverlay/i
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      if (FORBIDDEN.test(text)) hits.push(path.slice(ROOT.length + 1))
    }
  }
  walk(join(ROOT, 'src'))
  check('no src file spells a retired family or its tables', hits.length === 0, hits.join(', '))
}

section('§4 a retired name resolves exactly as an unknown name does')
{
  const { getSyntaxTheme } = await import('../../src/components/StructuredDiff/colorDiff.js')
  const unknownTheme = JSON.stringify(themeMod.getTheme(UNKNOWN))
  const unknownTokens = JSON.stringify(tokensMod.resolveMercuryTokens(UNKNOWN, '#DD4444'))
  const unknownSyntax = JSON.stringify(getSyntaxTheme(UNKNOWN))
  for (const name of RETIRED) {
    check(
      `${name}: getTheme resolves as the unknown name does`,
      JSON.stringify(themeMod.getTheme(name)) === unknownTheme,
    )
    check(
      `${name}: adaptive tokens resolve as the unknown name's do`,
      JSON.stringify(tokensMod.resolveMercuryTokens(name, '#DD4444')) === unknownTokens,
    )
    check(
      `${name}: the ground gate answers as it does for the unknown name`,
      tokensMod.isDarkThemeFamily(name) === tokensMod.isDarkThemeFamily(UNKNOWN),
    )
    check(
      `${name}: the syntax theme resolves as the unknown name's does`,
      JSON.stringify(getSyntaxTheme(name)) === unknownSyntax,
    )
  }
}

section('§5 a stored retired name steers nothing, exactly as a stored unknown name')
{
  const cfg = await import('../../src/utils/config.js')
  const provider = await import('../../src/components/design-system/ThemeProvider.js')
  const { DEFAULT_THEME_SETTING } = systemMod
  const storedAtStart = cfg.getGlobalConfig().theme
  delete process.env.MERCURY_THEME_PIN
  for (const name of [...RETIRED, UNKNOWN]) {
    cfg.saveGlobalConfig(c => ({ ...c, theme: name }))
    check(
      `stored ${name}: the resolution owner answers the default, like any unknown name`,
      provider.currentStoredThemeSetting() === DEFAULT_THEME_SETTING,
      provider.currentStoredThemeSetting(),
    )
  }
  cfg.saveGlobalConfig(c => ({ ...c, theme: storedAtStart }))
  process.env.MERCURY_THEME_PIN = 'dark-ansi'
  check(
    'a retired name through the pin is ignored like any invalid pin (the stored value stands)',
    provider.currentStoredThemeSetting() === storedAtStart,
    provider.currentStoredThemeSetting(),
  )
  process.env.MERCURY_THEME_PIN = 'dark'
  check('a living appearance through the pin pins this process', provider.currentStoredThemeSetting() === 'dark')
  delete process.env.MERCURY_THEME_PIN
  check('the config under test is restored', cfg.getGlobalConfig().theme === storedAtStart)
}

section('§6 auto resolves to the oasis appearance on every terminal')
{
  check('resolveThemeSetting(auto) is the oasis appearance', systemMod.resolveThemeSetting('auto') === 'dark')
  check('the system-theme name is the oasis appearance', systemMod.getSystemThemeName() === 'dark')
  const cfg = await import('../../src/utils/config.js')
  const provider = await import('../../src/components/design-system/ThemeProvider.js')
  const storedAtStart = cfg.getGlobalConfig().theme
  cfg.saveGlobalConfig(c => ({ ...c, theme: 'auto' }))
  check(
    'a stored auto keeps working: the resolution owner answers the default appearance',
    provider.currentStoredThemeSetting() === systemMod.DEFAULT_THEME_SETTING,
    provider.currentStoredThemeSetting(),
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
  check('every manifest entry records a living appearance', retired.length === 0, retired.join(', '))
  const grids = readdirSync(join(ROOT, 'design-system/live/grids')).filter(f => f.endsWith('.grid.json')).sort()
  const named = manifest.entries.map(e => e.gridPath.replace(/^grids\//, '')).sort()
  check(
    'the grids directory holds exactly the manifest entries',
    JSON.stringify(grids) === JSON.stringify(named),
    `${grids.length} grids vs ${named.length} entries`,
  )
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\ntheme roster: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
