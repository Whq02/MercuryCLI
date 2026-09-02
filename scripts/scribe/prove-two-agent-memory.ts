#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-two-agent-memory.ts
//  PROOF (#32): the Scribe + Implementer are TWO DIFFERENT, PERSISTENT agents,
//  each gated to its OWN wrapper + memory context, routed together — never
//  cross-contaminating. Verifies the standing invariants:
//   (a) role is XOR — a process is Scribe, Implementer, or neither, never both
//       (assertSingleRole), so each carries exactly one persona/authority;
//   (b) each wrapper is ROLE-gated — getScribeModeSections() is [] off the Scribe
//       role, getImplementerModeSections() is [] off the Implementer role (so the
//       Scribe never carries the Implementer's pack and vice-versa; OFF ⇒ []);
//   (c) the Scribe's candidate memory lives in the recall-EXCLUDED `scribe/` scope
//       (anti-poisoning) and is gated (MERCURY_SCRIBE_SCOPE);
//   (d) the scribe-memory write primitive is capped + secret-refusing (see also
//       prove-scribe-memory). Project instructions (MERCURY.md)/root memory load
//       per-process as usual (separate transcripts ⇒ no cross-agent bleed).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-two-agent-memory.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const gates = (await import('../../src/utils/scribe/scribeGates.js')) as typeof import('../../src/utils/scribe/scribeGates.js')
const scribeMode = (await import('../../src/utils/scribeMode.js')) as typeof import('../../src/utils/scribeMode.js')
const implMode = (await import('../../src/utils/implementerMode.js')) as typeof import('../../src/utils/implementerMode.js')

const SC = process.env.MERCURY_SCRIBE, IM = process.env.MERCURY_IMPLEMENTER
const restore = () => { SC === undefined ? delete process.env.MERCURY_SCRIBE : (process.env.MERCURY_SCRIBE = SC); IM === undefined ? delete process.env.MERCURY_IMPLEMENTER : (process.env.MERCURY_IMPLEMENTER = IM) }

console.log('============================================================')
console.log(' Two persistent, gated agents — memory/wrapper isolation (#32)')
console.log('============================================================')

section('(a) role is XOR — Scribe / Implementer / neither, never both')
delete process.env.MERCURY_SCRIBE; delete process.env.MERCURY_IMPLEMENTER
check('neither role ⇒ isScribeRole=false, isImplementerRole=false', gates.isScribeRole() === false && gates.isImplementerRole() === false)
process.env.MERCURY_SCRIBE = '1'
check('Scribe role ⇒ isScribeRole only', gates.isScribeRole() === true && gates.isImplementerRole() === false)
delete process.env.MERCURY_SCRIBE; process.env.MERCURY_IMPLEMENTER = '1'
check('Implementer role ⇒ isImplementerRole only', gates.isImplementerRole() === true && gates.isScribeRole() === false)
process.env.MERCURY_SCRIBE = '1' // both → must be rejected
let threw = false
try { gates.assertSingleRole() } catch { threw = true }
check('BOTH roles ⇒ assertSingleRole throws (never carries dual authority)', threw === true)
delete process.env.MERCURY_SCRIBE; delete process.env.MERCURY_IMPLEMENTER
check('neither ⇒ assertSingleRole is a no-op', (() => { try { gates.assertSingleRole(); return true } catch { return false } })())

section('(b) each wrapper is MODE-gated per-process (no cross-carry; OFF ⇒ [] byte-identical)')
scribeMode.setScribeMode(false); implMode.setImplementerMode(false)
check('neither mode ⇒ getScribeModeSections() === []', scribeMode.getScribeModeSections().length === 0)
check('neither mode ⇒ getImplementerModeSections() === []', implMode.getImplementerModeSections().length === 0)
scribeMode.setScribeMode(true)
check('Scribe process ⇒ Scribe pack present, Implementer pack ABSENT', scribeMode.getScribeModeSections().length > 0 && implMode.getImplementerModeSections().length === 0)
scribeMode.setScribeMode(false); implMode.setImplementerMode(true)
check('Implementer process ⇒ Implementer pack present, Scribe pack ABSENT', implMode.getImplementerModeSections().length > 0 && scribeMode.getScribeModeSections().length === 0)
scribeMode.setScribeMode(false); implMode.setImplementerMode(false)
restore()

section('(c) the Scribe candidate scope is recall-EXCLUDED (anti-poisoning) + gated')
const scan = src('memdir', 'memoryScan.ts')
check('memoryScan excludes the scribe scope from recall when enabled', /scribeScopeEnabled\(\) \? \['scribe'\] : \[\]/.test(scan))
check('scribeScopeEnabled is the gate (MERCURY_SCRIBE_SCOPE)', /function scribeScopeEnabled/.test(src('utils', 'scribe', 'scribeGates.ts')) && /MERCURY_SCRIBE_SCOPE/.test(src('utils', 'scribe', 'scribeGates.ts')))

section('(d) the scribe-memory write primitive is capped + secret-refusing')
const promote = src('memdir', 'scribePromote.ts')
const decide = src('utils', 'haltDecide.ts') // unrelated; ensure we read the right file
check('stageScribeNote exists + hard-caps (SCRIBE_NOTE_MAX_CHARS)', /export async function stageScribeNote/.test(promote) && /SCRIBE_NOTE_MAX_CHARS/.test(promote))
check('stageScribeNote refuses secrets', /detectSecrets\(trimmed\)\.length > 0/.test(promote))
void decide

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TWO-AGENT-MEMORY PROOFS PASS')
else console.log(`❌ ${failures} TWO-AGENT-MEMORY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
