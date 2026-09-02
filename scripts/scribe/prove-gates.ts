#!/usr/bin/env bun

import {
  scribeModeEnabled,
  implementerModeEnabled,
  scribeScopeEnabled,
  scribeBusEnabled,
  isScribeRole,
  isImplementerRole,
  assertSingleRole,
} from '../../src/utils/scribe/scribeGates.js'
import { isImplementerSpawnEnabled } from '../../src/daemon/daemonFeatureGates.js'

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

const GATES: Array<{ name: string; fn: () => boolean; flag: string }> = [
  { name: 'scribeModeEnabled', fn: scribeModeEnabled, flag: 'MERCURY_SCRIBE_MODE' },
  { name: 'implementerModeEnabled', fn: implementerModeEnabled, flag: 'MERCURY_SCRIBE_IMPLEMENTER' },
  { name: 'scribeScopeEnabled', fn: scribeScopeEnabled, flag: 'MERCURY_SCRIBE_SCOPE' },
  { name: 'scribeBusEnabled', fn: scribeBusEnabled, flag: 'MERCURY_SCRIBE_BUS' },
  { name: 'isImplementerSpawnEnabled', fn: isImplementerSpawnEnabled, flag: 'MERCURY_AMANUENSIS' },
]

function clearGateEnv(): void {
  for (const g of GATES) delete process.env[g.flag]
}

console.log('============================================================')
console.log(' Scribe-mode (Amanuensis) gates + roles — Phase-0 proof')
console.log('============================================================')

section('PROOF 0 — bare stamp ⇒ every gate STILL live (stamp-independence)')
setStamp(false)
clearGateEnv()
for (const g of GATES) check(`${g.name}() TRUE under a bare stamp`, g.fn() === true)

section('PROOF 1 — fork DEFAULT (no env) ⇒ every gate LIVE')
setStamp(true)
clearGateEnv()
for (const g of GATES) check(`${g.name}() TRUE on fork by default`, g.fn() === true)

section('PROOF 2 — fork + flag=0 ⇒ that gate off (explicit per-flag opt-out)')
setStamp(true)
for (const g of GATES) {
  clearGateEnv()
  process.env[g.flag] = '0'
  check(`${g.flag}=0 disables ${g.name}`, g.fn() === false)
  const sibling = GATES.find(o => o.name !== g.name)!
  check(`  ${sibling.name} stays on (independent opt-out)`, sibling.fn() === true)
}
clearGateEnv()

section('PROOF 3 — fork + flag=1 ⇒ on')
setStamp(true)
clearGateEnv()
for (const g of GATES) {
  process.env[g.flag] = '1'
  check(`${g.flag}=1 ⇒ ${g.name} on`, g.fn() === true)
}
clearGateEnv()

section('PROOF 4 — role discriminator (MERCURY_SCRIBE / MERCURY_IMPLEMENTER)')
function clearRoleEnv(): void {
  delete process.env.MERCURY_SCRIBE
  delete process.env.MERCURY_IMPLEMENTER
}
clearRoleEnv()
check('no role env ⇒ isScribeRole() false', isScribeRole() === false)
check('no role env ⇒ isImplementerRole() false', isImplementerRole() === false)
check('no role env ⇒ assertSingleRole() does not throw', (() => { try { assertSingleRole(); return true } catch { return false } })())

process.env.MERCURY_SCRIBE = '1'
check('MERCURY_SCRIBE=1 ⇒ isScribeRole() true', isScribeRole() === true)
check('MERCURY_SCRIBE=1 ⇒ isImplementerRole() false', isImplementerRole() === false)
check('single scribe role ⇒ assertSingleRole() ok', (() => { try { assertSingleRole(); return true } catch { return false } })())

clearRoleEnv()
process.env.MERCURY_IMPLEMENTER = '1'
check('MERCURY_IMPLEMENTER=1 ⇒ isImplementerRole() true', isImplementerRole() === true)
check('MERCURY_IMPLEMENTER=1 ⇒ isScribeRole() false', isScribeRole() === false)
check('single implementer role ⇒ assertSingleRole() ok', (() => { try { assertSingleRole(); return true } catch { return false } })())

process.env.MERCURY_SCRIBE = '1'
check('BOTH roles set ⇒ assertSingleRole() THROWS (a process is one role)', (() => { try { assertSingleRole(); return false } catch { return true } })())
clearRoleEnv()

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-GATE PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
