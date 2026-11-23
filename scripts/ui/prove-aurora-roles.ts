#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
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
console.log(' AURORA — semantic color choreography invariants')
console.log('============================================================')

const themeMod = await import('../../src/screen/theme/theme.js')
const tokensMod = await import('../../src/screen/theme/mercuryTokens.js')
const brand = await import('../../src/screen/theme/mercuryPalette.js')
const accentMod = await import('../../src/screen/widgets/sessionAccent.js')
const critterData = await import('../../src/screen/cockpit/critterData.js')
const permMode = await import('../../src/permissions/rules/permissionMode.js')

const FAMILIES = themeMod.THEME_NAMES
const dark = themeMod.getTheme('dark')
const liveAccent = accentMod.getSessionAccent().accent

section('§1 — the INFO channel exists and owns the informational roles')
{
  for (const family of FAMILIES) {
    const t = themeMod.getTheme(family)
    check(`${family}: info + infoShimmer + promptBorderResting resolve`,
      typeof t.info === 'string' && t.info.length > 0 &&
      typeof t.infoShimmer === 'string' && t.infoShimmer.length > 0 &&
      typeof t.promptBorderResting === 'string' && t.promptBorderResting.length > 0,
      '', 'every theme returned by getTheme in src/screen/theme/theme.ts must define info, infoShimmer and promptBorderResting as non-empty colours')
  }
  check('dark info = OASIS (the companion hue, spent at last)', dark.info === brand.OASIS, '', 'the dark theme in src/screen/theme/theme.ts must set info to OASIS from src/screen/theme/mercuryPalette.ts')
  check('dark infoShimmer brightens toward ivory', dark.infoShimmer === themeMod.lerpHex(brand.OASIS, brand.IVORY, 0.4), '', 'the dark theme in src/screen/theme/theme.ts must set infoShimmer to lerpHex(OASIS, IVORY, 0.4)')
  for (const role of ['bashBorder', 'background', 'professionalBlue', 'chromeYellow', 'ide', 'merged', 'remember', 'rate_limit_fill', 'systemSpinner'] as const) {
    check(`dark ${role} rides info (OASIS), not identity`, dark[role] === brand.OASIS, '', `the dark theme in src/screen/theme/theme.ts must set ${role} to OASIS`)
  }
  check('dark promptBorderResting is STRUCTURE (DUNE)', dark.promptBorderResting === brand.DUNE, '', 'the dark theme in src/screen/theme/theme.ts must set promptBorderResting to DUNE')
  check('info ≠ identity accent on dark', dark.info !== liveAccent, '', 'the dark theme info in src/screen/theme/theme.ts must not equal the session accent from getSessionAccent')
}

section('§2 — identity keeps the accent; the status spine stays fixed')
{
  check('brand (the Mercury voice) = the session accent', dark.brand === liveAccent, '', 'the dark theme in src/screen/theme/theme.ts must set brand to the session accent')
  check('suggestion (current focus) = the session accent', dark.suggestion === liveAccent, '', 'the dark theme in src/screen/theme/theme.ts must set suggestion to the session accent')
  check('permission (consent/focus thread) = the session accent', dark.permission === liveAccent, '', 'the dark theme in src/screen/theme/theme.ts must set permission to the session accent')
  check('promptBorder (COMPOSING) = the session accent', dark.promptBorder === liveAccent, '', 'the dark theme in src/screen/theme/theme.ts must set promptBorder to the session accent')
  check('success = TEAL (fixed)', dark.success === brand.TEAL, '', 'the dark theme in src/screen/theme/theme.ts must set success to TEAL')
  check('warning = AMBER (fixed)', dark.warning === brand.AMBER, '', 'the dark theme in src/screen/theme/theme.ts must set warning to AMBER')
  check('error = CRIMSON (fixed)', dark.error === brand.CRIMSON, '', 'the dark theme in src/screen/theme/theme.ts must set error to CRIMSON')
  check('autoAccept = AMBER (standing caution, fixed meaning)', dark.autoAccept === brand.AMBER, '', 'the dark theme in src/screen/theme/theme.ts must set autoAccept to AMBER')
  check('identity red ≠ failure crimson', brand.TERRA !== brand.CRIMSON, '', 'TERRA and CRIMSON in src/screen/theme/mercuryPalette.ts must be two different colours')
}

section('§3 — the mode ladder: fixed, pairwise-distinct semantics (dark)')
{
  const roleOf = (m: string) => permMode.getModeColor(m as never)
  const hueOf = (m: string) => dark[roleOf(m) as keyof typeof dark] as string
  check("apollo → 'permission' role", roleOf('apollo') === 'permission', '', 'getModeColor in src/permissions/rules/permissionMode.ts must return permission for apollo')
  check("implement → 'autoAccept' role", roleOf('implement') === 'autoAccept', '', 'getModeColor in src/permissions/rules/permissionMode.ts must return autoAccept for implement')
  check("sovereign → 'error' role", roleOf('sovereign') === 'error', '', 'getModeColor in src/permissions/rules/permissionMode.ts must return error for sovereign')
  check("flow → 'success' role", roleOf('flow') === 'success', '', 'getModeColor in src/permissions/rules/permissionMode.ts must return success for flow')
  const hues = ['apollo', 'implement', 'sovereign', 'flow'].map(hueOf)
  check('apollo(permission) · implement(AMBER) · sovereign(CRIMSON) · flow(TEAL) pairwise distinct',
    new Set(hues).size === 4, hues.join(' '), 'the four modes must resolve to four different colours; check getModeColor in src/permissions/rules/permissionMode.ts and the dark theme in src/screen/theme/theme.ts')
  check('implement resolves AMBER-caution', hueOf('implement') === brand.AMBER, '', 'the dark theme in src/screen/theme/theme.ts must give the autoAccept role AMBER')
}

section('§4 — ACCENT BLOOM: derived per accent, per family')
{
  const t = (name: string, accent: string) => tokensMod.resolveMercuryTokens(name, accent)
  check('crab (TERRA) keeps the authored BELLY byte-equal',
    t('dark', brand.TERRA).accentSoft === brand.BELLY, '', 'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must return BELLY as accentSoft for the TERRA accent')
  const others: Array<[string, string]> = [
    ['octopus', critterData.OCTOPUS_HUE],
    ['jellyfish', critterData.JELLYFISH_HUE],
    ['clam', critterData.CLAM_HUE],
  ]
  for (const [name, hue] of others) {
    const soft = t('dark', hue).accentSoft
    check(`${name} blooms from its OWN hue (≠ crab coral, = derived)`,
      soft !== brand.BELLY && soft === tokensMod.deriveAccentSoft(hue, brand.IVORY), soft, 'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must derive accentSoft from the accent with deriveAccentSoft toward IVORY')
  }
  const unknownTheme = themeMod.getTheme('not-a-theme')
  check('the unknown name blooms toward the resolved primary ink',
    t('not-a-theme', brand.TERRA).accentSoft === tokensMod.deriveAccentSoft(brand.TERRA, unknownTheme.text), '', 'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must derive accentSoft toward the text colour of the resolved theme for an unknown theme name')
  check('an unparseable role collapses the bloom onto the accent',
    t('not-a-theme', 'ansi:red').accentSoft === 'ansi:red', '', 'deriveAccentSoft in src/screen/theme/mercuryTokens.ts must return the accent itself when it cannot parse it')
  check('unknown-name info comes from theme.info (never the accent-circular permission)',
    t('not-a-theme', brand.TERRA).info === unknownTheme.info, '', 'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must take info from the resolved theme.info for an unknown theme name')
  check('dark tokens.info = OASIS', t('dark', brand.TERRA).info === brand.OASIS, '', 'resolveMercuryTokens in src/screen/theme/mercuryTokens.ts must return OASIS as info for the dark theme')
}


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL AURORA ROLE PROOFS PASS')
else {
  console.log(`❌ ${failures} AURORA ROLE PROOF(S) FAILED`)
  process.exit(1)
}
