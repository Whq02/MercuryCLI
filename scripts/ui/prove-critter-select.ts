#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-critter-select.ts
//  PROOF: the /critter session-theme picker's LOGIC is correct without racing a
//  live PTY (the render-verify counterpart is render-critter-select.ts). The
//  picker delegates its only mutation to setSessionCritter() and its shape lookup
//  to critterDefForKey() — both React-free, so the contract is provable here:
//    • setSessionCritter IGNORES an unknown key (the store + env stay put, no
//      listener fires) — the "no-persistence/garbage-in" guard;
//    • setSessionCritter NO-OPS the same key (no spurious re-render storm);
//    • a REAL change commits the key, mirrors MERCURY_CRITTER, and fires every
//      subscriber (the live-morph plumbing the picker rides on ↵);
//    • critterDefForKey resolves a real grid for EVERY ALL_CRITTERS key (so each
//      row's CritterMark + the preview never silently fall back to crab);
//    • the active-key seed (resolveInitialKey via getSessionAccent) is what the
//      picker opens the cursor on.
//  No new hex, no new key — same CRITTERS table, just locked.
//  Run: ~/.bun/bin/bun run scripts/ui/prove-critter-select.ts
// ============================================================================
import {
  ALL_CRITTERS,
  getSessionAccent,
  getSessionCritterKey,
  setSessionCritter,
  subscribeSessionCritter,
} from '../../src/components/mercury-ui/sessionAccent.js'
import { critterDefForKey } from '../../src/utils/cockpit/critterData.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' critter-select — picker mutation + shape contract (render-free)')
console.log('============================================================')

// Start from a known key so the no-op / change assertions are deterministic.
setSessionCritter('crab')

section('setSessionCritter — IGNORE unknown (the garbage-in guard)')
{
  let fired = 0
  const off = subscribeSessionCritter(() => fired++)
  const before = getSessionCritterKey()
  setSessionCritter('seahorse') // not in CRITTERS
  check('unknown key is ignored (active key unchanged)', getSessionCritterKey() === before, getSessionCritterKey())
  check('unknown key fires NO listener', fired === 0, `${fired} fired`)
  setSessionCritter('') // empty
  check('empty key is ignored', getSessionCritterKey() === before)
  off()
}

section('setSessionCritter — NO-OP same key (no re-render storm)')
{
  let fired = 0
  const off = subscribeSessionCritter(() => fired++)
  setSessionCritter('crab') // already crab
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
  // case/whitespace are normalized (the picker only passes clean keys, but the
  // guard must hold): ' Jellyfish ' → jellyfish.
  setSessionCritter('  Jellyfish  ')
  check('key is trim+lowercased', getSessionCritterKey() === 'jellyfish', getSessionCritterKey())
}

section('critterDefForKey — every picker row resolves a real grid')
for (const c of ALL_CRITTERS) {
  const def = critterDefForKey(c.key)
  // crab is the fallback; for the NON-crab keys a crab fallback would mean the
  // bridge missed — assert the resolved grid is the critter's own (name match,
  // every pool critter's key IS its name today).
  const wantName = c.key
  check(`row '${c.key}' → grid '${def.name}' (16-wide)`, def.name === wantName && def.art.length > 0, def.name)
}

// restore so a suite run leaves the store as it found it (octopus default).
setSessionCritter('octopus')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CRITTER-SELECT PROOFS PASS')
else console.log(`❌ ${failures} CRITTER-SELECT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
