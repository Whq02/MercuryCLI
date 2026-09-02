#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-regulation.ts
//  PROOF (Phase 5 Task 5.3): the Scribe self-regulation assessor maps a snapshot
//  (context %, repeated errors, cumulative tokens) to the right remediation —
//  /clear the implementer, pause the loop, or ESCALATE TO THE HUMAN (the hard
//  token ceiling escalates to the operator, not just the Scribe). Exercised
//  against the REAL pure module (src/utils/scribe/scribeRegulation.ts).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-regulation.ts
// ============================================================================

import {
  assessRegulation,
  getScribeTokenCeiling,
  REGULATION_CONTEXT_CLEAR_PCT,
  REGULATION_THRASH_ERRORS,
} from '../../src/utils/scribe/scribeRegulation.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Scribe self-regulation — Phase-5 Task 5.3 proof')
console.log('============================================================')

section('each signal maps to its remediation')
check('all clear ⇒ ok', assessRegulation({ contextPercent: 20, repeatedErrors: 0, tokenTotal: 1000 }).action === 'ok')
check(`context >= ${REGULATION_CONTEXT_CLEAR_PCT}% ⇒ clear-implementer`, assessRegulation({ contextPercent: 90 }).action === 'clear-implementer')
check(`>= ${REGULATION_THRASH_ERRORS} repeated errors ⇒ pause`, assessRegulation({ repeatedErrors: REGULATION_THRASH_ERRORS }).action === 'pause')
check('over the token ceiling ⇒ escalate-human', assessRegulation({ tokenTotal: getScribeTokenCeiling() + 1 }).action === 'escalate-human')

section('severity order: hard ceiling (human) beats thrash beats context')
check('ceiling + context-high + thrash ⇒ escalate-human (most severe)', assessRegulation({ contextPercent: 99, repeatedErrors: 99, tokenTotal: getScribeTokenCeiling() + 1 }).action === 'escalate-human')
check('thrash + context-high (under ceiling) ⇒ pause', assessRegulation({ contextPercent: 99, repeatedErrors: REGULATION_THRASH_ERRORS, tokenTotal: 0 }).action === 'pause')
check('every verdict carries a reason', assessRegulation({ contextPercent: 90 }).reason.length > 0)

section('escalation target is the HUMAN, not just the Scribe')
const v = assessRegulation({ tokenTotal: getScribeTokenCeiling() + 1 })
check('token-ceiling verdict names the human/operator', /human|operator/i.test(v.reason))

section('token ceiling is env-tunable (MERCURY_SCRIBE_TOKEN_CEILING)')
const base = getScribeTokenCeiling()
process.env.MERCURY_SCRIBE_TOKEN_CEILING = String(base * 2)
check('env override raises the ceiling', getScribeTokenCeiling() === base * 2)
check('a total that was over the default is now ok', assessRegulation({ tokenTotal: base + 1 }).action === 'ok')
process.env.MERCURY_SCRIBE_TOKEN_CEILING = 'garbage'
check('non-numeric env ⇒ falls back to the default', getScribeTokenCeiling() === base)
delete process.env.MERCURY_SCRIBE_TOKEN_CEILING

section('robust to missing fields (partial snapshots)')
check('empty snapshot ⇒ ok', assessRegulation({}).action === 'ok')

section('#43 R2 — the governor is now LIVE (was dead: zero importers) + telemetry honest on respawn')
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
const gates = (await import('../../src/utils/scribe/scribeGates.js')) as typeof import('../../src/utils/scribe/scribeGates.js')
delete process.env.MERCURY_SCRIBE_AUTOCLEAR
check('scribeAutoClearEnabled default-ON', gates.scribeAutoClearEnabled() === true)
process.env.MERCURY_SCRIBE_AUTOCLEAR = '0'
check('MERCURY_SCRIBE_AUTOCLEAR=0 ⇒ OFF (byte-identical, no auto-clear)', gates.scribeAutoClearEnabled() === false)
delete process.env.MERCURY_SCRIBE_AUTOCLEAR
const roster = src('daemon', 'roster.ts')
check('roster.autoClearIfContextFull: idle + ctx>=threshold ⇒ respawn (fresh transcript)', /autoClearIfContextFull\(short: string\)/.test(roster) && /seatIsIdle\(ll\)/.test(roster) && /ll\.contextPct \?\? 0\) < REGULATION_CONTEXT_CLEAR_PCT/.test(roster) && /this\.reconfigureLongLived\(short, \{\}\)/.test(roster))
check('respawn resets contextPct + lastDeliveredAt (stale ctx no longer lies post-clear)', /ll\.contextPct = undefined/.test(roster) && /ll\.lastDeliveredAt = undefined/.test(roster))
const main = src('daemon', 'main.ts')
check('the daemon dispatch-tick CALLS autoClearIfContextFull (gated) — the governor runs', /scribeAutoClearEnabled\(\)/.test(main) && /if \(autoClear\) r\.autoClearIfContextFull\('implementer'\)/.test(main))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL REGULATION PROOFS PASS')
else console.log(`❌ ${failures} REGULATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
