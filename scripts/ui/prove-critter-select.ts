#!/usr/bin/env bun
import {
  ALL_CRITTERS,
  getSessionAccent,
  getSessionCritterKey,
  setSessionCritter,
  subscribeSessionCritter,
} from '../../src/screen/widgets/sessionAccent.js'
import { critterDefForKey } from '../../src/screen/cockpit/critterData.js'

let failures = 0
const critterSelectHint = 'change setSessionCritter, getSessionCritterKey or ALL_CRITTERS in src/screen/widgets/sessionAccent.ts, or critterDefForKey in src/screen/cockpit/critterData.ts for a picker row that resolves the wrong grid'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? (detail ? ` — ${detail}` : '') : ` — ${detail ? `${detail} · ` : ''}${critterSelectHint}`}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' critter-select — picker mutation + shape contract (render-free)')
console.log('============================================================')

setSessionCritter('crab')

section('setSessionCritter — IGNORE unknown (the garbage-in guard)')
{
  let fired = 0
  const off = subscribeSessionCritter(() => fired++)
  const before = getSessionCritterKey()
  setSessionCritter('seahorse')
  check('unknown key is ignored (active key unchanged)', getSessionCritterKey() === before, getSessionCritterKey())
  check('unknown key fires NO listener', fired === 0, `${fired} fired`)
  setSessionCritter('')
  check('empty key is ignored', getSessionCritterKey() === before)
  off()
}

section('setSessionCritter — NO-OP same key (no re-render storm)')
{
  let fired = 0
  const off = subscribeSessionCritter(() => fired++)
  setSessionCritter('crab')
  check('committing the SAME key fires NO listener', fired === 0, `${fired} fired`)
  off()
}

section('setSessionCritter — a REAL change commits + mirrors + fires')
{
  let fired = 0
  const off = subscribeSessionCritter(() => fired++)
  setSessionCritter('octopus')
  check('active key becomes the new critter', getSessionCritterKey() === 'octopus', getSessionCritterKey())
  check('getSessionAccent() follows (the picker · active flag)', getSessionAccent().key === 'octopus')
  check('a real change fires exactly one listener tick', fired === 1, `${fired} fired`)
  check('MERCURY_CRITTER env is mirrored (fresh-subtree agreement)', process.env.MERCURY_CRITTER === 'octopus', String(process.env.MERCURY_CRITTER))
  off()
  setSessionCritter('  Jellyfish  ')
  check('key is trim+lowercased', getSessionCritterKey() === 'jellyfish', getSessionCritterKey())
}

section('critterDefForKey — every picker row resolves a real grid')
for (const c of ALL_CRITTERS) {
  const def = critterDefForKey(c.key)
  const wantName = c.key
  check(`row '${c.key}' resolves '${def.name}'`, def.name === wantName, def.name)
}

setSessionCritter('octopus')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CRITTER-SELECT PROOFS PASS')
else console.log(`❌ ${failures} CRITTER-SELECT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
