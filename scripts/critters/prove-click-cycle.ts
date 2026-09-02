#!/usr/bin/env bun
// ============================================================================
//  prove-click-cycle — click-to-cycle works at EVERY size (the operator's word;
//  it worked only at large).
//
//  Two layers:
//    §1 THE ONE OWNER, behaviorally: cycleSessionCritter() advances the
//       live session-critter store through the whole pool and wraps, each
//       pick both MORPPHING the live store and PERSISTING the default
//       (GlobalConfig.defaultCritter) — the picks-stick contract.
//    §2 THE MOUNTS: every critter pointer target — the hero (MercuryHero),
//       the cockpit berth (PinnedCritterBerth), and the mini form
//       (MiniCritter, both the sub-hero row and the bare deck dock) — hands
//       its click seam EXACTLY the one owner. Source-anchored enrollment:
//       a mount that grows its own inline cycle (or loses the handler)
//       goes red here.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'click-cycle-proof-'))
delete process.env.MERCURY_CRITTER

const { enableConfigs, getGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()

const { ALL_CRITTERS, cycleSessionCritter, getSessionAccent } = await import(
  '../../src/components/mercury-ui/sessionAccent.ts'
)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('click-to-cycle — one owner, every size')

console.log('\n§1 the one owner cycles the pool and picks stick')
{
  const start = getSessionAccent().key
  const seen: string[] = [start]
  for (let i = 0; i < ALL_CRITTERS.length; i++) {
    cycleSessionCritter()
    seen.push(getSessionAccent().key)
  }
  check(
    'a full cycle visits every pool critter exactly once and wraps',
    new Set(seen.slice(0, ALL_CRITTERS.length)).size === ALL_CRITTERS.length &&
      seen[ALL_CRITTERS.length] === start,
    seen.join(' → '),
  )
  cycleSessionCritter()
  const afterOne = getSessionAccent().key
  check('the pick is live in the store (morph)', afterOne !== start, afterOne)
  check(
    'the pick PERSISTS as the cross-relaunch default',
    getGlobalConfig().defaultCritter === afterOne,
    `config=${String(getGlobalConfig().defaultCritter)} store=${afterOne}`,
  )
  const accent = getSessionAccent()
  check(
    'the accent follows the cycled key (shape and tint agree)',
    ALL_CRITTERS.some(c => c.key === accent.key && c.accent === accent.accent),
  )
}

console.log('\n§2 every mount hands its pointer seam the one owner')
{
  const repo = join(import.meta.dir, '..', '..')
  const home = readFileSync(join(repo, 'src/components/MercuryHome.tsx'), 'utf8')
  const mini = readFileSync(join(repo, 'src/components/mercury-ui/MiniCritter.tsx'), 'utf8')
  check(
    'the hero click is the one owner (onClick={cycleSessionCritter})',
    home.includes('onClick={cycleSessionCritter}'),
  )
  check(
    'the berth activate is the one owner (onActivate={cycleSessionCritter})',
    home.includes('onActivate={cycleSessionCritter}'),
  )
  check(
    'the mini art is clickable through the one owner — BOTH mounts (sub-hero row + bare deck dock)',
    (mini.match(/onClick=\{cycleSessionCritter\}/g) ?? []).length === 2,
  )
  check(
    'no mount re-implements the cycle inline (zero stray ALL_CRITTERS index math in the mounts)',
    !home.includes('ALL_CRITTERS.findIndex') && !mini.includes('ALL_CRITTERS.findIndex'),
  )
}

if (failures > 0) {
  console.error(`\n❌ ${failures} CLICK-CYCLE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL CLICK-CYCLE PROOFS PASS')
