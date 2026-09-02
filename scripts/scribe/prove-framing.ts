#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-framing.ts
//  PROOF (Phase 2 Task 2.4): inbound teammate-mailbox content is prefixed with
//  the operator-authority framing ONLY in the Implementer process with the
//  feature on; identity (byte-identical) everywhere else — crucially including
//  a NORMAL fork session that is not the Implementer. Exercised against the REAL
//  helper (src/utils/scribe/implementerFraming.ts).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-framing.ts
//
//  NOTE: the gate is implementerModeEnabled() && isImplementerRole() — a
//  correctness sharpening of the plan's "double-gate": the role discriminator
//  (built in Task 0.1) scopes the prefix to the Implementer process, so a
//  normal fork session's mailbox is untouched. messages.ts is too heavy to load
//  under bun-run, so the seam WIRING is verified structurally against source.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  frameInboundForImplementer,
  IMPLEMENTER_INBOUND_AUTHORITY_FRAMING,
} from '../../src/utils/scribe/implementerFraming.js'

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
function clearEnv(): void {
  delete process.env.MERCURY_IMPLEMENTER
  delete process.env.MERCURY_SCRIBE
  delete process.env.MERCURY_SCRIBE_IMPLEMENTER
}

const SAMPLE = '<system-reminder>\n# Messages\nfrom scribe: do the thing\n</system-reminder>'

console.log('============================================================')
console.log(' Implementer inbound-authority framing — Phase-2 Task 2.4 proof')
console.log('============================================================')

section('identity (byte-identical) everywhere except the Implementer process')
setStamp(false); clearEnv()
check('bare-stamp ⇒ identity', frameInboundForImplementer(SAMPLE) === SAMPLE)

setStamp(true); clearEnv()
check('fork, NOT implementer role (normal session) ⇒ identity', frameInboundForImplementer(SAMPLE) === SAMPLE)

setStamp(true); clearEnv(); process.env.MERCURY_SCRIBE = '1'
check('fork, Scribe role ⇒ identity (framing is implementer-only)', frameInboundForImplementer(SAMPLE) === SAMPLE)

section('prefixed ONLY in the Implementer process with the feature on')
setStamp(true); clearEnv(); process.env.MERCURY_IMPLEMENTER = '1'
const framed = frameInboundForImplementer(SAMPLE)
check('fork + implementer role (default) ⇒ prefixed', framed !== SAMPLE && framed.startsWith(IMPLEMENTER_INBOUND_AUTHORITY_FRAMING))
check('framing mentions operator authority', /operator’s authority|operator authority/i.test(IMPLEMENTER_INBOUND_AUTHORITY_FRAMING))
check('framing says escalate to the Scribe, never the human', /Scribe.*never the human|never the human/i.test(IMPLEMENTER_INBOUND_AUTHORITY_FRAMING))
check('original content is preserved after the prefix', framed.endsWith(SAMPLE))

setStamp(true); clearEnv(); process.env.MERCURY_IMPLEMENTER = '1'; process.env.MERCURY_SCRIBE_IMPLEMENTER = '0'
check('implementer role + MERCURY_SCRIBE_IMPLEMENTER=0 ⇒ identity (opt-out)', frameInboundForImplementer(SAMPLE) === SAMPLE)
clearEnv()

section('seam wiring (structural, src) — NOT a UserPromptSubmit hook')
const msgsSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'messages', 'attachmentText.ts'), 'utf-8')
check('messages.ts imports frameInboundForImplementer', msgsSrc.includes('frameInboundForImplementer'))
check('framing wraps the teammate_mailbox formatTeammateMessages render', /frameInboundForImplementer\(\s*getTeammateMailbox\(\)\.formatTeammateMessages/.test(msgsSrc))

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL FRAMING PROOFS PASS')
else console.log(`❌ ${failures} FRAMING PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
