#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-appearance-system.ts — the adaptive Mercury theme system
//
//
//    §1 token completeness: every concrete family resolves EVERY semantic
//       role to a non-empty value (canvas is deliberately absent on light
//       families — the profile ground is theirs)
//    §2 the dark family IS the oasis brand expression (byte-equal mapping);
//       light/daltonized/ansi map from their OWN accessibility palettes
//    §3 agent accents: 8 per family, pairwise distinct, stable across calls
//    §4 the ground follows the theme: dark families paint OSC 11, light
//       families never do; the sync handles live theme changes both ways
//    §5 one canonical picker: the duplicate HermesThemePicker is ABSENT; the
//       /appearance center embeds the live ThemePicker and persists motion
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-appearance-system.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Appearance system — adaptive tokens, theme-true ground')
console.log('============================================================')

const tokensMod = await import('../../src/utils/mercuryTokens.js')
const themeMod = await import('../../src/utils/theme.js')
const brand = await import('../../src/components/mercuryPalette.js')

const ACCENT = '#DD4444'
const FAMILIES = themeMod.THEME_NAMES

section('§1 — token completeness across every concrete family')
{
  for (const family of FAMILIES) {
    const t = tokensMod.resolveMercuryTokens(family, ACCENT)
    // The ONE owner law: listUnresolvedTokenRoles walks structured tokens
    // (spectral ramps, agent accents) by shape; canvas stays optional.
    const empty = tokensMod.listUnresolvedTokenRoles(t)
    check(`${family}: every semantic role resolves`, empty.length === 0, empty.join(','))
    const ramps = Object.entries(t.spectral)
    check(
      `${family}: every spectral ramp resolves to at least one usable stop`,
      ramps.length === 5 &&
        ramps.every(([, ramp]) => ramp.length >= 1 && ramp.every(stop => typeof stop === 'string' && stop.length > 0)),
      ramps.map(([k, ramp]) => `${k}:${ramp.length}`).join(' '),
    )
    check(`${family}: frozen`, Object.isFrozen(t))
    const dark = tokensMod.isDarkThemeFamily(family)
    // The canvas is the family's OWN ground (groundFamilyFor — oasis NIGHT
    // everywhere except the black-anchored true-black appearance).
    const expectedCanvas = brand.groundFamilyFor(family).NIGHT
    check(`${family}: canvas ${dark ? 'painted' : 'left to the profile'}`, dark ? t.canvas === expectedCanvas : t.canvas === undefined)
  }
}

section('§2 — deliberate expressions, not dark leftovers')
{
  const dark = tokensMod.resolveMercuryTokens('dark', ACCENT)
  check('dark = the oasis brand mapping (ink)', dark.textPrimary === brand.IVORY && dark.textMuted === brand.FAINT)
  check('dark = the oasis brand mapping (surfaces)', dark.surface1 === brand.ASH && dark.borderStrong === brand.DUNE)
  check('dark = the oasis brand mapping (status spine)', dark.success === brand.TEAL && dark.warning === brand.AMBER && dark.failure === brand.CRIMSON)
  check('dark diff spine = the brand diff tints', dark.diffAddRow === brand.DIFF_ADD_BG && dark.diffRemoveWord === brand.DIFF_DEL_WORD)

  const light = tokensMod.resolveMercuryTokens('light', ACCENT)
  const lightTheme = themeMod.getTheme('light')
  check('light ink comes from the LIGHT palette, never IVORY', light.textPrimary === lightTheme.text && light.textPrimary !== brand.IVORY)
  check('light status spine comes from the light palette', light.success === lightTheme.success && light.failure === lightTheme.error)
  check('light diff colors come from the light palette', light.diffAddRow === lightTheme.diffAdded)

  const daltonized = tokensMod.resolveMercuryTokens('dark-daltonized', ACCENT)
  const daltTheme = themeMod.getTheme('dark-daltonized')
  check('daltonized palettes stay authoritative (success/failure)', daltonized.success === daltTheme.success && daltonized.failure === daltTheme.error)

  const ansi = tokensMod.resolveMercuryTokens('light-ansi', ACCENT)
  check('ansi family quantizes through its own named colors', ansi.success.startsWith('ansi:'))
  check('the identity accent rides every family', light.accent === ACCENT && daltonized.accent === ACCENT && ansi.accent === ACCENT)
}

section('§3 — agent accents')
{
  for (const family of FAMILIES) {
    const t = tokensMod.resolveMercuryTokens(family, ACCENT)
    check(`${family}: 8 agent accents`, t.agentAccents.length === 8)
    const colors = t.agentAccents.map(a => a.color)
    const names = t.agentAccents.map(a => a.name)
    if (family.endsWith('-ansi')) {
      // 16-color reality: orange/pink collapse onto their nearest named color
      // — INTENTIONAL quantization; the NAME survives as the meaning carrier.
      check(`${family}: ≥6 distinct after intentional quantization`, new Set(colors).size >= 6, `${new Set(colors).size}`)
      check(`${family}: names stay pairwise distinct (meaning never rides color alone)`, new Set(names).size === 8)
    } else {
      check(`${family}: pairwise distinct`, new Set(colors).size === colors.length)
    }
  }
  const a = tokensMod.resolveMercuryTokens('dark', ACCENT)
  const b = tokensMod.resolveMercuryTokens('dark', ACCENT)
  check('stable across calls (memoized identity)', a === b)
}

section('§4 — the ground follows the theme')
{
  const oasis = await import('../../src/utils/cockpit/oasisBg.js')
  delete process.env.MERCURY_OASIS_BG
  process.env.TERM = 'xterm-256color'
  check('dark family + TTY ⇒ ground enabled', oasis.oasisBgEnabled(true, 'dark') === true)
  check('dark-daltonized ⇒ ground enabled', oasis.oasisBgEnabled(true, 'dark-daltonized') === true)
  check('light family ⇒ ground NEVER painted', oasis.oasisBgEnabled(true, 'light') === false)
  check('light-ansi ⇒ ground NEVER painted', oasis.oasisBgEnabled(true, 'light-ansi') === false)
  check('MERCURY_OASIS_BG=0 still kills it', (process.env.MERCURY_OASIS_BG = '0', oasis.oasisBgEnabled(true, 'dark') === false))
  delete process.env.MERCURY_OASIS_BG

  // Live sync both ways (writes captured, never emitted). The proof runs
  // piped, so stub the TTY bit the enter gate consults.
  const realIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  const out: string[] = []
  oasis.syncOasisBgToTheme('dark', s => out.push(s))
  const painted = out.some(s => s.includes(']11;'))
  oasis.syncOasisBgToTheme('light', s => out.push(s))
  const restored = out.some(s => s.includes(']111'))
  check('sync dark ⇒ paints once', painted)
  check('sync to light ⇒ hands the profile ground back', restored)
  const before = out.length
  oasis.syncOasisBgToTheme('light', s => out.push(s))
  check('sync is idempotent (no repeat restore)', out.length === before)
  Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })

  const provider = src('components', 'design-system', 'ThemeProvider.tsx')
  // Pin re-cut onto the landed rewrite spelling (the resolved-theme variable
  // is `resolvedTheme`) — same invariant: the effect re-syncs the ground on
  // every live resolved-theme change.
  check(
    'the provider re-syncs the ground on EVERY live theme change',
    provider.includes('syncOasisBgToTheme(resolvedTheme)') && /\[resolvedTheme\]\)/.test(provider),
  )
}

section('§5 — one canonical picker + the /appearance center')
{
  check('the duplicate HermesThemePicker is deleted', !existsSync(join(ROOT, 'src', 'components', 'HermesThemePicker.tsx')))
  const appearanceCmd = (await import('../../src/commands/appearance/index.js')).default
  check('/appearance is registered + discoverable', appearanceCmd.name === 'appearance' && appearanceCmd.isHidden !== true)
  const center = src('commands', 'appearance', 'appearance.tsx')
  check('the center embeds the CANONICAL ThemePicker (live preview/apply/cancel)', center.includes('<ThemePicker'))
  check('the center consumes semantic tokens, not fixed brand ink', center.includes('useMercuryTokens()') && !/IVORY|FAINT|NIGHT/.test(center))
  check('accent section shows the LIVE accent with deep links', center.includes('useSessionAccent()') && center.includes('/critter picks the creature'))
  check('motion persists through the real settings owner', center.includes("updateSettingsForSource('userSettings', {") && center.includes('prefersReducedMotion'))
  check('motion acknowledges SYNCHRONOUSLY (local override ahead of the async file-watcher read)', center.includes('motionOverride ?? settingsReduced'))
  const hook = src('components', 'mercury-ui', 'useMercuryTokens.ts')
  check('the live hook subscribes to theme + accent', hook.includes('useTheme()') && hook.includes('useSessionAccent()'))
}

section('§6 — True Black: the second appearance')
{
  // The registry: exactly TWO reachable appearances, dark first.
  const reachable = themeMod.REACHABLE_THEME_SETTINGS as readonly string[]
  check(
    'the reachable registry carries exactly two appearances (dark · true-black)',
    reachable.length === 2 && reachable[0] === 'dark' && reachable[1] === 'true-black',
    reachable.join(','),
  )
  check(
    'true-black is a persisted theme name (settings + pin vocabulary)',
    (themeMod.THEME_NAMES as readonly string[]).includes('true-black') &&
      (themeMod.THEME_SETTINGS as readonly string[]).includes('true-black'),
  )

  // The ground family: the exact #000000 anchor, every step below its oasis
  // twin, the ladder strictly ascending.
  const bl = brand.TRUE_BLACK_GROUND
  const oa = brand.OASIS_GROUND
  const lum = (hex: string): number =>
    parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
  const steps = ['NIGHT', 'NIGHT_SOFT', 'ASH', 'ASH_RAISED', 'DUNE_FAINT', 'DUNE'] as const
  check('the deep ground is EXACT #000000', bl.NIGHT === '#000000')
  check(
    'every black step sits below its oasis counterpart',
    steps.every(k => lum(bl[k]) < lum(oa[k])),
    steps.map(k => `${k}:${lum(bl[k])}<${lum(oa[k])}`).join(' '),
  )
  check(
    'the black ladder ascends strictly (panels stay separable on pure black)',
    steps.every((k, i) => i === 0 || lum(bl[k]) > lum(bl[steps[i - 1]!])),
  )

  // Tokens: the SAME authored expression, re-anchored grounds.
  const tb = tokensMod.resolveMercuryTokens('true-black', ACCENT)
  const dk = tokensMod.resolveMercuryTokens('dark', ACCENT)
  check('true-black canvas = #000000', tb.canvas === '#000000')
  check(
    'surfaces ride the black family',
    tb.surface0 === bl.NIGHT_SOFT && tb.surface1 === bl.ASH && tb.surface2 === bl.ASH_RAISED,
  )
  check(
    'ink, accent and the status spine are byte-equal to dark',
    tb.textPrimary === dk.textPrimary &&
      tb.textSecondary === dk.textSecondary &&
      tb.accent === dk.accent &&
      tb.success === dk.success &&
      tb.warning === dk.warning &&
      tb.failure === dk.failure,
  )
  check(
    'the diff spine is byte-equal to dark',
    tb.diffAddRow === dk.diffAddRow && tb.diffRemoveWord === dk.diffRemoveWord,
  )
  const tbTheme = themeMod.getTheme('true-black')
  check(
    'the resolved theme surfaces ride the black family (the overlay is ground-aware)',
    tbTheme.selectionBg === bl.ASH &&
      tbTheme.userMessageBackground === bl.ASH_RAISED &&
      tbTheme.messageActionsBackground === bl.DUNE,
  )
  check('true-black is a dark family (ground gate + native diff spine)', tokensMod.isDarkThemeFamily('true-black'))

  // The ground channel round-trip: dark ⇄ true-black repaints the VALUE
  // each way while the channel stays held — the observable the picker's
  // preview (focus) / apply (enter) / restore (esc) path drives.
  const oasis = await import('../../src/utils/cockpit/oasisBg.js')
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
  )
  check('re-sync of the same appearance never repaints', writes.length === afterSwitch + 1)
  check(
    'switching home repaints the oasis ground (the round trip restores exactly)',
    writes[2]?.includes(`]11;${oa.NIGHT}`) === true,
  )

  // The picker rows: both appearances, labeled, with the preview/apply/
  // restore wiring on the canonical Select.
  const picker = src('components', 'ThemePicker.tsx')
  check(
    'the picker labels both appearances (True Black by name)',
    picker.includes("'true-black': 'True Black'") && picker.includes("dark: 'Oasis dark'"),
  )
  check(
    'the picker previews on focus, saves on select, releases on cancel',
    picker.includes('setPreviewTheme(value)') &&
      picker.includes('savePreview()') &&
      picker.includes('cancelPreview()'),
  )
  const config = src('components', 'Settings', 'Config.tsx')
  check("the /config submenu labels true-black", config.includes("'true-black': 'True Black'"))
  const onboarding = src('components', 'Onboarding.tsx')
  check(
    'the first-run fitting offers both appearances',
    onboarding.includes("value: 'dark'") && onboarding.includes("value: 'true-black'"),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL APPEARANCE-SYSTEM PROOFS PASS')
else {
  console.log(`❌ ${failures} APPEARANCE-SYSTEM PROOF(S) FAILED`)
  process.exit(1)
}
