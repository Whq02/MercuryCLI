#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' AURORA — semantic color choreography invariants')
console.log('============================================================')

const themeMod = await import('../../src/utils/theme.js')
const tokensMod = await import('../../src/utils/mercuryTokens.js')
const brand = await import('../../src/components/mercuryPalette.js')
const accentMod = await import('../../src/components/mercury-ui/sessionAccent.js')
const critterData = await import('../../src/utils/cockpit/critterData.js')
const permMode = await import('../../src/utils/permissions/PermissionMode.js')

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
      typeof t.promptBorderResting === 'string' && t.promptBorderResting.length > 0)
  }
  check('dark info = OASIS (the companion hue, spent at last)', dark.info === brand.OASIS)
  check('dark infoShimmer brightens toward ivory', dark.infoShimmer === themeMod.lerpHex(brand.OASIS, brand.IVORY, 0.4))
  for (const role of ['bashBorder', 'background', 'professionalBlue', 'chromeYellow', 'ide', 'merged', 'remember', 'rate_limit_fill', 'systemSpinner'] as const) {
    check(`dark ${role} rides info (OASIS), not identity`, dark[role] === brand.OASIS)
  }
  check('dark promptBorderResting is STRUCTURE (DUNE)', dark.promptBorderResting === brand.DUNE)
  check('info ≠ identity accent on dark', dark.info !== liveAccent)
}

section('§2 — identity keeps the accent; the status spine stays fixed')
{
  check('brand (the Mercury voice) = the session accent', dark.brand === liveAccent)
  check('suggestion (current focus) = the session accent', dark.suggestion === liveAccent)
  check('permission (consent/focus thread) = the session accent', dark.permission === liveAccent)
  check('promptBorder (COMPOSING) = the session accent', dark.promptBorder === liveAccent)
  check('success = TEAL (fixed)', dark.success === brand.TEAL)
  check('warning = AMBER (fixed)', dark.warning === brand.AMBER)
  check('error = CRIMSON (fixed)', dark.error === brand.CRIMSON)
  check('autoAccept = AMBER (standing caution, fixed meaning)', dark.autoAccept === brand.AMBER)
  check('identity red ≠ failure crimson', brand.TERRA !== brand.CRIMSON)
}

section('§3 — the mode ladder: fixed, pairwise-distinct semantics (dark)')
{
  const roleOf = (m: string) => permMode.getModeColor(m as never)
  const hueOf = (m: string) => dark[roleOf(m) as keyof typeof dark] as string
  check("apollo → 'permission' role", roleOf('apollo') === 'permission')
  check("implement → 'autoAccept' role", roleOf('implement') === 'autoAccept')
  check("sovereign → 'error' role", roleOf('sovereign') === 'error')
  check("flow → 'success' role", roleOf('flow') === 'success')
  const hues = ['apollo', 'implement', 'sovereign', 'flow'].map(hueOf)
  check('apollo(permission) · implement(AMBER) · sovereign(CRIMSON) · flow(TEAL) pairwise distinct',
    new Set(hues).size === 4, hues.join(' '))
  check('implement resolves AMBER-caution', hueOf('implement') === brand.AMBER)
}

section('§4 — ACCENT BLOOM: derived per accent, per family')
{
  const t = (name: string, accent: string) => tokensMod.resolveMercuryTokens(name, accent)
  check('crab (TERRA) keeps the authored BELLY byte-equal',
    t('dark', brand.TERRA).accentSoft === brand.BELLY)
  const others: Array<[string, string]> = [
    ['octopus', critterData.OCTOPUS_HUE],
    ['jellyfish', critterData.JELLYFISH_HUE],
    ['clam', critterData.CLAM_HUE],
  ]
  for (const [name, hue] of others) {
    const soft = t('dark', hue).accentSoft
    check(`${name} blooms from its OWN hue (≠ crab coral, = derived)`,
      soft !== brand.BELLY && soft === tokensMod.deriveAccentSoft(hue, brand.IVORY), soft)
  }
  const unknownTheme = themeMod.getTheme('not-a-theme')
  check('the unknown name blooms toward the resolved primary ink',
    t('not-a-theme', brand.TERRA).accentSoft === tokensMod.deriveAccentSoft(brand.TERRA, unknownTheme.text))
  check('an unparseable role collapses the bloom onto the accent',
    t('not-a-theme', 'ansi:red').accentSoft === 'ansi:red')
  check('unknown-name info comes from theme.info (never the accent-circular permission)',
    t('not-a-theme', brand.TERRA).info === unknownTheme.info)
  check('dark tokens.info = OASIS', t('dark', brand.TERRA).info === brand.OASIS)
}


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL AURORA ROLE PROOFS PASS')
else {
  console.log(`❌ ${failures} AURORA ROLE PROOF(S) FAILED`)
  process.exit(1)
}
