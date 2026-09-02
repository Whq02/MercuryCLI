#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-substrate-umbrella.ts
//  PROOF: the MERCURY_SUBSTRATE umbrella is WIRED LIVE
//  and that flipping it correctly drives the three SAFE, behavior-additive
//  gates it OR's into — invocation trace, cache-aware compaction, persistent
//  deck pane — exercised against the REAL production code, not a reimpl.
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-substrate-umbrella.ts
//
//  Under bun-run, the build stamp is false (no build-time MACRO). We
//  simulate a stamped build by setting globalThis.MACRO (config.ts reads MACRO at
//  CALL time via `typeof MACRO`), so we can prove BOTH states in one file:
//   - bare-stamp  ⇒ umbrella OFF (default-on is stamp-gated), all 3 gates off
//   - fork dflt ⇒ umbrella ON  (no env needed), all 3 gates on  ← the live wire
//   - fork =0   ⇒ umbrella OFF (explicit opt-out), all 3 gates off
//   - fork =1   ⇒ umbrella ON
//  Plus: the individual flags still force a gate on for a stamped build.
// ============================================================================

import { isMercurySubstrateProfileOn } from '../../src/utils/config.js'
import { isInvocationTraceEnabled } from '../../src/utils/observability/invocationTrace.js'
import { substrateSnapshot } from '../../src/utils/cockpit/substrateSnapshot.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// ── helpers ────────────────────────────────────────────────────────────────
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
function clearEnv(): void {
  delete process.env.MERCURY_SUBSTRATE
  delete process.env.MERCURY_TRACE
  delete process.env.MERCURY_CTX_COMPACTION
  delete process.env.MERCURY_DECK_PANE
  delete process.env.MERCURY_COORDINATION_MCP
}
/** Read the three safe-set rows out of the live /substrate catalog. */
function gates(): { trace: boolean; ctx: boolean; deck: boolean; umbrella: boolean } {
  const rows = substrateSnapshot().data.sections.flatMap(s => s.rows)
  const by = (name: string) => rows.find(r => r.name === name)?.on === true
  return {
    trace: by('Invocation trace'),
    ctx: by('Compact advance + breaker'),
    deck: by('Persistent deck pane'),
    mcp: by('Coordination MCP server (mercury)'),
    umbrella: substrateSnapshot().data.substrateOn,
  }
}

console.log('============================================================')
console.log(' MERCURY_SUBSTRATE umbrella — WIRED LIVE proof')
console.log('============================================================')

// ── PROOF 0 the defaults are stamp-blind.
section('PROOF 0 — bare stamp ⇒ umbrella STILL on (stamp-independence)')
setStamp(false)
clearEnv()
check('isMercurySubstrateProfileOn() TRUE under a bare stamp (stamp-independence)', isMercurySubstrateProfileOn() === true)
check('isInvocationTraceEnabled() TRUE under a bare stamp', isInvocationTraceEnabled() === true)
{
  const g = gates()
  check('substrate catalog: trace on under a bare stamp', g.trace === true)
  check('substrate catalog: ctx-compaction on under a bare stamp', g.ctx === true)
  check('substrate catalog: deck pane on under a bare stamp', g.deck === true)
}

// ── PROOF 1 — fork DEFAULT (no env): the live wire ───────────────────────────
section('PROOF 1 — fork DEFAULT (no env) ⇒ umbrella ON, all 3 safe gates ON')
setStamp(true)
clearEnv()
check('isMercurySubstrateProfileOn() TRUE on fork by default (no MERCURY_SUBSTRATE)', isMercurySubstrateProfileOn() === true)
check('isInvocationTraceEnabled() TRUE on fork by default', isInvocationTraceEnabled() === true)
{
  const g = gates()
  check('substrate catalog: substrateOn true', g.umbrella === true)
  check('substrate catalog: invocation trace LIVE by default', g.trace === true)
  check('substrate catalog: compact advance + breaker LIVE by default', g.ctx === true)
  check('substrate catalog: persistent deck pane LIVE by default', g.deck === true)
}

// ── PROOF 2 — fork + explicit opt-out =0: everything back off ─────────────────
section('PROOF 2 — MERCURY_SUBSTRATE=0 ⇒ umbrella OFF (opt-out)')
setStamp(true)
clearEnv()
process.env.MERCURY_SUBSTRATE = '0'
check('isMercurySubstrateProfileOn() false with =0 (explicit opt-out wins)', isMercurySubstrateProfileOn() === false)
check('isInvocationTraceEnabled() false with =0 and no per-flag override', isInvocationTraceEnabled() === false)
{
  const g = gates()
  check('substrate catalog: trace off under opt-out', g.trace === false)
  check('substrate catalog: ctx-compaction off under opt-out', g.ctx === false)
  check('substrate catalog: deck pane off under opt-out', g.deck === false)
}

// ── PROOF 3 — MERCURY_SUBSTRATE=1: explicit on ─────────────────────────
section('PROOF 3 — MERCURY_SUBSTRATE=1 ⇒ umbrella ON')
setStamp(true)
clearEnv()
process.env.MERCURY_SUBSTRATE = '1'
check('isMercurySubstrateProfileOn() true with =1', isMercurySubstrateProfileOn() === true)
check('isInvocationTraceEnabled() true with =1', isInvocationTraceEnabled() === true)

// ── PROOF 4 — per-flag override still works under opt-out ─────────────────────
section('PROOF 4 — per-flag override survives the =0 umbrella opt-out')
setStamp(true)
clearEnv()
process.env.MERCURY_SUBSTRATE = '0' // umbrella off…
process.env.MERCURY_TRACE = '1' //     …but trace explicitly on
check('isInvocationTraceEnabled() TRUE: MERCURY_TRACE=1 overrides umbrella =0', isInvocationTraceEnabled() === true)
{
  const g = gates()
  check('substrate catalog: trace on via per-flag despite umbrella off', g.trace === true)
  check('substrate catalog: ctx-compaction still off (no per-flag)', g.ctx === false)
  process.env.MERCURY_CTX_COMPACTION = '1'
  const g2 = gates()
  check('substrate catalog: ctx-compaction on via its own flag despite umbrella off', g2.ctx === true)
}

// ── PROOF 5 — the coordination server: default-on, INDEPENDENT of umbrella
section('PROOF 5 — the coordination server live (stamp-independent), independent of the umbrella')
setStamp(false)
clearEnv()
check('bare stamp ⇒ the coordination server STILL on (stamp-independence)', gates().mcp === true)
setStamp(true)
clearEnv()
check('fork default ⇒ the coordination server LIVE (coordination verbs ready for mid-session teams)', gates().mcp === true)
process.env.MERCURY_SUBSTRATE = '0'
check('the coordination server stays on under MERCURY_SUBSTRATE=0 (NOT part of the umbrella)', gates().mcp === true)
clearEnv()
process.env.MERCURY_COORDINATION_MCP = '0'
check('MERCURY_COORDINATION_MCP=0 ⇒ the coordination server off (its own opt-out)', gates().mcp === false)

// ── cleanup ──────────────────────────────────────────────────────────────────
setStamp(false)
clearEnv()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SUBSTRATE-UMBRELLA PROOFS PASS')
else console.log(`❌ ${failures} SUBSTRATE-UMBRELLA PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
