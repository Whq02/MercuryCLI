#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — fix: ${fix}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Appearance system — adaptive tokens, theme-true ground')
console.log('============================================================')

const tokensMod = await import('../../src/screen/theme/mercuryTokens.js')
const themeMod = await import('../../src/screen/theme/theme.js')
const brand = await import('../../src/screen/theme/mercuryPalette.js')

const ACCENT = '#DD4444'
const FAMILIES = themeMod.THEME_NAMES

section('§1 — token completeness across every concrete family')
{
  for (const family of FAMILIES) {
    const t = tokensMod.resolveMercuryTokens(family, ACCENT)
    const empty = tokensMod.listUnresolvedTokenRoles(t)
    check(`${family}: every semantic role resolves`, empty.length === 0, empty.join(','), 'give each listed role a value for this family in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts)')
    const ramps = Object.entries(t.spectral)
    check(
      `${family}: every spectral ramp resolves to at least one usable stop`,
      ramps.length === 5 &&
        ramps.every(([, ramp]) => ramp.length >= 1 && ramp.every(stop => typeof stop === 'string' && stop.length > 0)),
      ramps.map(([k, ramp]) => `${k}:${ramp.length}`).join(' '),
      'resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) must return five non-empty spectral ramps for this family',
    )
    check(`${family}: frozen`, Object.isFrozen(t), '', 'resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) must return a frozen tokens object')
    const dark = tokensMod.isDarkThemeFamily(family)
    const expectedCanvas = brand.groundFamilyFor(family).NIGHT
    check(`${family}: canvas ${dark ? 'painted' : 'left to the profile'}`, dark ? t.canvas === expectedCanvas : t.canvas === undefined, '', `canvas is ${String(t.canvas)}; dark families take brand.groundFamilyFor(family).NIGHT as canvas, others leave it undefined, in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts)`)
  }
}

section('§2 — deliberate expressions, not dark leftovers')
{
  const dark = tokensMod.resolveMercuryTokens('dark', ACCENT)
  check('dark = the oasis brand mapping (ink)', dark.textPrimary === brand.IVORY && dark.textMuted === brand.FAINT)
  check('dark = the oasis brand mapping (surfaces)', dark.surface1 === brand.ASH && dark.borderStrong === brand.DUNE)
  check('dark = the oasis brand mapping (status spine)', dark.success === brand.TEAL && dark.warning === brand.AMBER && dark.failure === brand.CRIMSON)
  check('dark diff spine = the brand diff tints', dark.diffAddRow === brand.DIFF_ADD_BG && dark.diffRemoveWord === brand.DIFF_DEL_WORD)

  const trueBlack = tokensMod.resolveMercuryTokens('true-black', ACCENT)
  check('true-black keeps the oasis ink on the black-anchored ground', trueBlack.textPrimary === brand.IVORY && trueBlack.surface1 !== dark.surface1)
  check('the identity accent rides every family', dark.accent === ACCENT && trueBlack.accent === ACCENT)
}

section('§3 — agent accents')
{
  for (const family of FAMILIES) {
    const t = tokensMod.resolveMercuryTokens(family, ACCENT)
    check(`${family}: 8 agent accents`, t.agentAccents.length === 8, '', `${t.agentAccents.length} accents; agentAccents in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) must hold exactly 8 entries`)
    const colors = t.agentAccents.map(a => a.color)
    const names = t.agentAccents.map(a => a.name)
    check(`${family}: pairwise distinct`, new Set(colors).size === colors.length, '', `colors ${colors.join(',')}; two agent accents share a color, make them distinct in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts)`)
    check(`${family}: names stay pairwise distinct (meaning never rides color alone)`, new Set(names).size === 8, '', `names ${names.join(',')}; two agent accents share a name, make them distinct in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts)`)
  }
  const a = tokensMod.resolveMercuryTokens('dark', ACCENT)
  const b = tokensMod.resolveMercuryTokens('dark', ACCENT)
  check('stable across calls (memoized identity)', a === b, '', 'resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) must return the same cached object for the same family and accent')
}

section('§4 — the ground follows the theme')
{
  const oasis = await import('../../src/screen/cockpit/oasisBg.js')
  delete process.env.MERCURY_OASIS_BG
  process.env.TERM = 'xterm-256color'
  check('dark family + TTY ⇒ ground enabled', oasis.oasisBgEnabled(true, 'dark') === true, '', 'oasisBgEnabled in src/screen/cockpit/oasisBg.ts must return true for a dark family on a TTY')
  check('true-black ⇒ ground enabled', oasis.oasisBgEnabled(true, 'true-black') === true, '', 'oasisBgEnabled in src/screen/cockpit/oasisBg.ts must return true for true-black on a TTY')
  check('an unknown name ⇒ ground NEVER painted', oasis.oasisBgEnabled(true, 'not-a-theme') === false, '', 'oasisBgEnabled in src/screen/cockpit/oasisBg.ts must return false for a name that is not a theme')
  check('MERCURY_OASIS_BG=0 still kills it', (process.env.MERCURY_OASIS_BG = '0', oasis.oasisBgEnabled(true, 'dark') === false), '', 'oasisBgEnabled in src/screen/cockpit/oasisBg.ts must return false while MERCURY_OASIS_BG is 0')
  delete process.env.MERCURY_OASIS_BG

  const realIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  const out: string[] = []
  oasis.syncOasisBgToTheme('dark', s => out.push(s))
  const painted = out.some(s => s.includes(']11;'))
  oasis.syncOasisBgToTheme('not-a-theme', s => out.push(s))
  const restored = out.some(s => s.includes(']111'))
  check('sync dark ⇒ paints once', painted, '', `writes ${out.join(' · ')}; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must write the OSC 11 ground for dark on a TTY`)
  check('sync to an unknown name ⇒ hands the profile ground back', restored, '', `writes ${out.join(' · ')}; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must write the OSC 111 restore for a name that is not a theme`)
  const before = out.length
  oasis.syncOasisBgToTheme('not-a-theme', s => out.push(s))
  check('sync is idempotent (no repeat restore)', out.length === before, '', `${out.length - before} extra writes; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must remember the last ground and skip a repeat restore`)
  Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })

}

section('§5 — one canonical picker + the /appearance center')
{
  const appearanceCmd = (await import('../../src/commands/appearance/index.js')).default
  check('/appearance is registered + discoverable', appearanceCmd.name === 'appearance' && appearanceCmd.isHidden !== true, '', 'the command in src/commands/appearance/index.ts must be named appearance and not hidden')
}

section('§6 — True Black: the second appearance')
{
  const reachable = themeMod.REACHABLE_THEME_SETTINGS as readonly string[]
  check(
    'the reachable registry carries exactly three appearances (dark · true-black · mono)',
    reachable.length === 3 && reachable[0] === 'dark' && reachable[1] === 'true-black' && reachable[2] === 'mono',
    reachable.join(','),
    'REACHABLE_THEME_SETTINGS in src/screen/theme/theme.ts must list dark, true-black, mono in that order',
  )
  check(
    'true-black is a persisted theme name (settings + pin vocabulary)',
    (themeMod.THEME_NAMES as readonly string[]).includes('true-black') &&
      (themeMod.THEME_SETTINGS as readonly string[]).includes('true-black'),
    '',
    'THEME_NAMES and THEME_SETTINGS in src/screen/theme/theme.ts must both include true-black',
  )

  const bl = brand.TRUE_BLACK_GROUND
  const oa = brand.OASIS_GROUND
  const lum = (hex: string): number =>
    parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
  const steps = ['NIGHT', 'NIGHT_SOFT', 'ASH', 'ASH_RAISED', 'DUNE_FAINT', 'DUNE'] as const
  check('the deep ground is EXACT #000000', bl.NIGHT === '#000000', '', `NIGHT is ${bl.NIGHT}; set NIGHT in TRUE_BLACK_GROUND (src/screen/theme/mercuryPalette.ts) to #000000`)
  check(
    'every black step sits below its oasis counterpart',
    steps.every(k => lum(bl[k]) < lum(oa[k])),
    steps.map(k => `${k}:${lum(bl[k])}<${lum(oa[k])}`).join(' '),
    'darken the step that is not below its oasis counterpart in TRUE_BLACK_GROUND (src/screen/theme/mercuryPalette.ts)',
  )
  check(
    'the black ladder ascends strictly (panels stay separable on pure black)',
    steps.every((k, i) => i === 0 || lum(bl[k]) > lum(bl[steps[i - 1]!])),
    '',
    steps.map(k => k + ':' + lum(bl[k])).join(' ') + '; make the steps of TRUE_BLACK_GROUND (src/screen/theme/mercuryPalette.ts) rise strictly from NIGHT to DUNE',
  )

  const tb = tokensMod.resolveMercuryTokens('true-black', ACCENT)
  const dk = tokensMod.resolveMercuryTokens('dark', ACCENT)
  check('true-black canvas = #000000', tb.canvas === '#000000', '', `canvas is ${String(tb.canvas)}; resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) must give true-black the canvas #000000`)
  check(
    'surfaces ride the black family',
    tb.surface0 === bl.NIGHT_SOFT && tb.surface1 === bl.ASH && tb.surface2 === bl.ASH_RAISED,
    '',
    `${tb.surface0} ${tb.surface1} ${tb.surface2}; resolveMercuryTokens (src/screen/theme/mercuryTokens.ts) must take true-black surfaces from TRUE_BLACK_GROUND (src/screen/theme/mercuryPalette.ts)`,
  )
  check(
    'ink, accent and the status spine are byte-equal to dark',
    tb.textPrimary === dk.textPrimary &&
      tb.textSecondary === dk.textSecondary &&
      tb.accent === dk.accent &&
      tb.success === dk.success &&
      tb.warning === dk.warning &&
      tb.failure === dk.failure,
    '',
    'true-black must reuse the dark ink, accent and status roles in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts)',
  )
  check(
    'the diff spine is byte-equal to dark',
    tb.diffAddRow === dk.diffAddRow && tb.diffRemoveWord === dk.diffRemoveWord,
    '',
    'true-black must reuse the dark diff roles in resolveMercuryTokens (src/screen/theme/mercuryTokens.ts)',
  )
  const tbTheme = themeMod.getTheme('true-black')
  check(
    'the resolved theme surfaces ride the black family (the overlay is ground-aware)',
    tbTheme.selectionBg === bl.ASH &&
      tbTheme.userMessageBackground === bl.ASH_RAISED &&
      tbTheme.messageActionsBackground === bl.DUNE,
    '',
    `${tbTheme.selectionBg} ${tbTheme.userMessageBackground} ${tbTheme.messageActionsBackground}; the true-black theme in src/screen/theme/theme.ts must take selectionBg, userMessageBackground and messageActionsBackground from TRUE_BLACK_GROUND`,
  )
  check('true-black is a dark family (ground gate + native diff spine)', tokensMod.isDarkThemeFamily('true-black'), '', 'isDarkThemeFamily in src/screen/theme/mercuryTokens.ts must return true for true-black')

  const oasis = await import('../../src/screen/cockpit/oasisBg.js')
  const realIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  oasis._resetGroundForTest()
  const writes: string[] = []
  oasis.syncOasisBgToTheme('dark', s => writes.push(s))
  oasis.syncOasisBgToTheme('true-black', s => writes.push(s))
  const afterSwitch = writes.length
  oasis.syncOasisBgToTheme('true-black', s => writes.push(s))
  oasis.syncOasisBgToTheme('dark', s => writes.push(s))
  Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })
  check(
    'dark paints the oasis ground, true-black repaints #000000',
    writes[0]?.includes(`]11;${oa.NIGHT}`) === true && writes[1]?.includes(']11;#000000') === true,
    writes.map(w => w.replace('\x1b', 'ESC').replace('\x07', '')).join(' · '),
    'syncOasisBgToTheme and oasisBgEnter in src/screen/cockpit/oasisBg.ts must paint the oasis NIGHT for dark and #000000 for true-black',
  )
  check('re-sync of the same appearance never repaints', writes.length === afterSwitch + 1, '', `${writes.length - afterSwitch} writes after the switch; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must skip a repeat sync of the same theme`)
  check(
    'switching home repaints the oasis ground (the round trip restores exactly)',
    writes[2]?.includes(`]11;${oa.NIGHT}`) === true,
    '',
    `writes ${writes.map(w => w.replace('\x1b', 'ESC').replace('\x07', '')).join(' · ')}; syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must repaint the oasis NIGHT when the theme returns to dark`,
  )

}

section('§7 — the default appearance: True Black, and a saved choice wins')
{
  const { DEFAULT_THEME_SETTING } = await import('../../src/screen/theme/systemTheme.js')
  const schema = await import('../../src/platform/config/schema.js')
  const cfg = await import('../../src/platform/settings/config.js')
  const provider = await import('../../src/screen/theme/ThemeProvider.js')
  const snapshot = await import('../../src/screen/widgets/appearanceSnapshot.js')
  const appearanceCmd = (await import('../../src/commands/appearance/index.js')).default
  const reachable = themeMod.REACHABLE_THEME_SETTINGS as readonly string[]

  check('the one owner names True Black', DEFAULT_THEME_SETTING === 'true-black', '', `it is ${DEFAULT_THEME_SETTING}; DEFAULT_THEME_SETTING in src/screen/theme/systemTheme.ts must be true-black`)
  check(
    'the default is a reachable appearance, with the oasis row beside it',
    reachable.includes(DEFAULT_THEME_SETTING) && reachable.includes('dark'),
    '',
    `${reachable.join(',')}; REACHABLE_THEME_SETTINGS in src/screen/theme/theme.ts must include DEFAULT_THEME_SETTING and dark`,
  )
  check(
    'a fresh config home carries the default (the factory value)',
    schema.createDefaultGlobalConfig().theme === DEFAULT_THEME_SETTING,
    '',
    `theme is ${String(schema.createDefaultGlobalConfig().theme)}; createDefaultGlobalConfig in src/platform/config/schema.ts must set theme to DEFAULT_THEME_SETTING`,
  )

  delete process.env.MERCURY_THEME_PIN
  const storedAtStart = cfg.getGlobalConfig().theme
  check(
    'nothing stored ⇒ the resolution owner answers the default',
    storedAtStart === DEFAULT_THEME_SETTING && provider.currentStoredThemeSetting() === DEFAULT_THEME_SETTING,
  )
  check(
    "/appearance's marker (the slash-menu current value) reads the default",
    appearanceCmd.currentValue?.() === DEFAULT_THEME_SETTING,
    '',
    'currentValue of the command in src/commands/appearance/index.ts must read the stored theme setting, default when nothing is stored',
  )
  const freshSnap = snapshot.getMercuryAppearanceSnapshot()
  check(
    'the health row owner (the appearance snapshot) resolves the default',
    freshSnap.requestedTheme === DEFAULT_THEME_SETTING && freshSnap.concreteTheme === DEFAULT_THEME_SETTING,
    '',
    'getMercuryAppearanceSnapshot in src/screen/widgets/appearanceSnapshot.ts must resolve the default theme',
  )

  cfg.saveGlobalConfig(c => ({ ...c, theme: 'dark' }))
  check(
    'a saved oasis choice wins over the default',
    provider.currentStoredThemeSetting() === 'dark' && appearanceCmd.currentValue?.() === 'dark',
    '',
    'currentStoredThemeSetting (src/screen/theme/ThemeProvider.tsx) and currentValue (src/commands/appearance/index.ts) must return a saved dark choice',
  )
  const darkSnap = snapshot.getMercuryAppearanceSnapshot()
  check('…and the health row reports it', darkSnap.requestedTheme === 'dark' && darkSnap.concreteTheme === 'dark', '', 'getMercuryAppearanceSnapshot in src/screen/widgets/appearanceSnapshot.ts must report the saved theme')
  cfg.saveGlobalConfig(c => ({ ...c, theme: 'true-black' }))
  check('a saved True Black choice stays True Black', provider.currentStoredThemeSetting() === 'true-black', '', 'currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must return a saved true-black choice')
  cfg.saveGlobalConfig(c => ({ ...c, theme: 'not-a-theme' }))
  check(
    'a stored unknown name collapses onto the default at the resolution owner',
    provider.currentStoredThemeSetting() === DEFAULT_THEME_SETTING,
    '',
    'currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must fall back to DEFAULT_THEME_SETTING for a stored name that is not a theme',
  )
  cfg.saveGlobalConfig(c => ({ ...c, theme: 'auto' }))
  check('a stored auto collapses onto the default too', provider.currentStoredThemeSetting() === DEFAULT_THEME_SETTING, '', 'currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must fall back to DEFAULT_THEME_SETTING for a stored auto')
  process.env.MERCURY_THEME_PIN = 'dark'
  check('the pin outranks the stored value (the capture seam)', provider.currentStoredThemeSetting() === 'dark', '', 'currentStoredThemeSetting in src/screen/theme/ThemeProvider.tsx must let MERCURY_THEME_PIN win over the stored value')
  delete process.env.MERCURY_THEME_PIN
  cfg.saveGlobalConfig(c => ({ ...c, theme: storedAtStart }))
  check('the config under test is restored', cfg.getGlobalConfig().theme === storedAtStart)

  const oasis = await import('../../src/screen/cockpit/oasisBg.js')
  delete process.env.MERCURY_OASIS_BG
  process.env.TERM = 'xterm-256color'
  check(
    'the default ground is pure black (the ground owner’s own default arm agrees)',
    oasis.oasisBgEnter(DEFAULT_THEME_SETTING) === '\x1b]11;#000000\x07' &&
      oasis.oasisBgEnter() === oasis.oasisBgEnter(DEFAULT_THEME_SETTING),
    '',
    'oasisBgEnter in src/screen/cockpit/oasisBg.ts must emit OSC 11 with #000000 for the default theme and default its argument to DEFAULT_THEME_SETTING',
  )
  check('the oasis ground is NIGHT', oasis.oasisBgEnter('dark') === `\x1b]11;${brand.OASIS_GROUND.NIGHT}\x07`, '', 'oasisBgEnter in src/screen/cockpit/oasisBg.ts must emit OSC 11 with OASIS_GROUND.NIGHT for dark')
  check(
    'both appearances enable the ground on a TTY; unasked, the gate reads the resolved default',
    oasis.oasisBgEnabled(true, DEFAULT_THEME_SETTING) && oasis.oasisBgEnabled(true, 'dark') && oasis.oasisBgEnabled(true),
    '',
    'oasisBgEnabled in src/screen/cockpit/oasisBg.ts must return true on a TTY for the default theme, dark, and with no theme given',
  )
  const realIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  oasis._resetGroundForTest()
  const boot: string[] = []
  oasis.syncOasisBgToTheme(DEFAULT_THEME_SETTING, s => boot.push(s))
  check(
    'a fresh boot paints #000000 once and never an oasis byte',
    boot.length === 1 && boot[0] === '\x1b]11;#000000\x07' && !boot.some(s => s.includes(brand.OASIS_GROUND.NIGHT)),
    boot.map(w => w.replace('\x1b', 'ESC').replace('\x07', '')).join(' · '),
    'syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must write only #000000 once on a fresh boot with the default theme',
  )
  process.env.MERCURY_OASIS_BG = '0'
  oasis._resetGroundForTest()
  const silent: string[] = []
  oasis.syncOasisBgToTheme(DEFAULT_THEME_SETTING, s => silent.push(s))
  check('MERCURY_OASIS_BG=0 keeps the default boot silent', silent.length === 0, '', 'syncOasisBgToTheme in src/screen/cockpit/oasisBg.ts must write nothing while MERCURY_OASIS_BG is 0')
  delete process.env.MERCURY_OASIS_BG
  oasis._resetGroundForTest()
  Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })

}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL APPEARANCE-SYSTEM PROOFS PASS')
else {
  console.log(`❌ ${failures} APPEARANCE-SYSTEM PROOF(S) FAILED`)
  process.exit(1)
}
