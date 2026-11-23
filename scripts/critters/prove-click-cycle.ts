#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'click-cycle-proof-'))
delete process.env.MERCURY_CRITTER

const { enableConfigs, getGlobalConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const { ALL_CRITTERS, cycleSessionCritter, getSessionAccent } = await import(
  '../../src/screen/widgets/sessionAccent.ts'
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
    `${seen.join(' → ')}; cycleSessionCritter in src/screen/widgets/sessionAccent.ts must step through ALL_CRITTERS and wrap to the start`,
  )
  cycleSessionCritter()
  const afterOne = getSessionAccent().key
  check('the pick is live in the store (morph)', afterOne !== start, `${afterOne}; cycleSessionCritter in src/screen/widgets/sessionAccent.ts did not change the session critter`)
  check(
    'the pick PERSISTS as the cross-relaunch default',
    getGlobalConfig().defaultCritter === afterOne,
    `config=${String(getGlobalConfig().defaultCritter)} store=${afterOne}; cycleSessionCritter must persist the pick as defaultCritter through persistSessionCritter in src/screen/widgets/sessionAccent.ts`,
  )
  const accent = getSessionAccent()
  check(
    'the accent follows the cycled key (shape and tint agree)',
    ALL_CRITTERS.some(c => c.key === accent.key && c.accent === accent.accent),
    `${accent.key} ${accent.accent}; getSessionAccent in src/screen/widgets/sessionAccent.ts must return the ALL_CRITTERS entry of the cycled key`,
  )
}


if (failures > 0) {
  console.error(`\n❌ ${failures} CLICK-CYCLE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL CLICK-CYCLE PROOFS PASS')
