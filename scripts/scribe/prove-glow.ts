#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-glow.ts
//  PROOF (Phase 7 Task 7.1 + critter-derived fix): the Scribe glow FOLLOWS the
//  active critter. With scribe mode engaged + the glow not opted out,
//  getSessionAccent() resolves to a glowing/incandescent version of the CURRENT
//  critter's accent: the crab keeps its hand-tuned ember-red
//  (SCRIBE_GLOW), and every other critter (clam/octopus/jellyfish) glows a
//  brightened version of ITS OWN accent (glowOf) — NOT a fixed red. With
//  MERCURY_SCRIBE_GLOW=0 (or scribe mode off, or bare-stamp) the accent is byte-identical
//  to the plain critter accent. Status spine semantics untouched.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-glow.ts
// ============================================================================

import {
  getSessionAccent,
  glowOf,
  SCRIBE_GLOW,
  scribeGlowEnabled,
  setSessionCritter,
} from '../../src/components/mercury-ui/sessionAccent.js'
import { setScribeMode } from '../../src/utils/scribeMode.js'
import { TERRA } from '../../src/components/mercuryPalette.js'
import { CLAM_HUE } from '../../src/utils/cockpit/critterData.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

console.log('============================================================')
console.log(' Scribe glow — Phase-7 Task 7.1 proof')
console.log('============================================================')

section('the glow hex itself')
const [r, g, b] = rgb(SCRIBE_GLOW)
check('SCRIBE_GLOW is a #rrggbb hex', /^#[0-9a-f]{6}$/i.test(SCRIBE_GLOW), SCRIBE_GLOW)
check('red family (R dominant)', r > g && r > b)
check('brighter/hotter than TERRA (higher R luminance)', r >= rgb(TERRA)[0])
check('NOT the current TERRA identity', SCRIBE_GLOW.toLowerCase() !== TERRA.toLowerCase())
check('NOT the prior lobster hue (#DE4A35)', SCRIBE_GLOW.toLowerCase() !== '#de4a35')

section('OFF ⇒ byte-identical to the normal critter accent')
setStamp(true)
setScribeMode(false)
// Pin the crab explicitly: the sections below assert the CRAB-specific ember
// rules (TERRA base, hand-tuned SCRIBE_GLOW), and the unset boot default is
// octopus — the fixture must not lean on the default.
setSessionCritter('crab')
delete process.env.MERCURY_SCRIBE_GLOW
check('scribe mode off ⇒ scribeGlowEnabled() false', scribeGlowEnabled() === false)
check('scribe mode off ⇒ accent is the normal crab TERRA', getSessionAccent().accent === TERRA)

setScribeMode(true)
process.env.MERCURY_SCRIBE_GLOW = '0'
check('scribe ON but MERCURY_SCRIBE_GLOW=0 ⇒ glow off', scribeGlowEnabled() === false)
check('opted out ⇒ accent byte-identical (TERRA)', getSessionAccent().accent === TERRA)
delete process.env.MERCURY_SCRIBE_GLOW

section('ON + crab (the mascot) ⇒ the hand-tuned ember (unchanged), spine stays fixed')
setScribeMode(true)
check('scribe ON + crab ⇒ scribeGlowEnabled() true', scribeGlowEnabled() === true)
check('crab glow === SCRIBE_GLOW (byte-identical default)', getSessionAccent().accent === SCRIBE_GLOW)
check('crab accentDeep is also a red-family ember', (() => { const [dr, dg, db] = rgb(getSessionAccent().accentDeep); return dr > dg && dr > db })())

section('ON + non-crab critter ⇒ the glow FOLLOWS the critter (not a fixed red)')
setSessionCritter('clam')
const clamGlow = getSessionAccent().accent
check('clam scribe glow === glowOf(CLAM_HUE) (critter-derived)', clamGlow === glowOf(CLAM_HUE))
check('clam glow is NOT the fixed SCRIBE_GLOW red', clamGlow.toLowerCase() !== SCRIBE_GLOW.toLowerCase())
{
  const [mr, mg, mb] = rgb(clamGlow)
  check('clam glow stays teal-family (G + B dominate R, not red)', mg > mr && mb > mr)
  const [br0, bg0, bb0] = rgb(CLAM_HUE)
  check('clam glow is BRIGHTER than the base clam accent', mr + mg + mb >= br0 + bg0 + bb0)
}
// glowOf is a pure brighten that preserves hue + never exceeds #ffffff.
check('glowOf is idempotent-safe at the ceiling (#ffffff → #ffffff)', glowOf('#ffffff') === '#ffffff')
check('glowOf preserves a #rrggbb shape', /^#[0-9a-f]{6}$/i.test(glowOf('#16d8b0')))
setSessionCritter('crab') // reset for the bare-stamp section below

// glow state is stamp-independent (equality probe
// against the fork-stamped values in the SAME mode state).
section('bare stamp ⇒ glow state unchanged (stamp-independence)')
setStamp(true)
const forkGlowEnabled = scribeGlowEnabled()
const forkAccent = getSessionAccent().accent
setStamp(false)
check('bare stamp ⇒ scribeGlowEnabled() unchanged', scribeGlowEnabled() === forkGlowEnabled)
check('bare stamp ⇒ accent unchanged', getSessionAccent().accent === forkAccent)
setScribeMode(false)
setStamp(false)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL GLOW PROOFS PASS')
else console.log(`❌ ${failures} GLOW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
