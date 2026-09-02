#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-telemetry.ts
//  W5 — dual-agent telemetry plumbing.
//   (a) parseUsageFromStreamJsonLine (pure): extracts usage from an assistant frame
//       (message.usage) and a result frame (top-level usage); null for non-usage /
//       non-JSON lines; absent counts → 0; end-to-end → a 0-100 context %.
//   (b) wire shape: WireRosterEntry carries optional model/effort/respawns/contextPct.
//   (c) roster: list() populates the long-lived telemetry; spawnLongLived parses the
//       drained stdout for usage (not just discards it).
//   (d) daemonRosterSnapshot: a never-throws foreground reader of a worker's entry.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-telemetry.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUsageFromStreamJsonLine } from '../../src/daemon/longLivedSupervisor.js'
import { calculateContextPercentages, getContextWindowForModel } from '../../src/utils/context.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' W5 dual-agent telemetry — usage parse + wire + roster')
console.log('============================================================')

section('(a) parseUsageFromStreamJsonLine (pure)')
const assistant = JSON.stringify({
  type: 'assistant',
  message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000 } },
})
const a = parseUsageFromStreamJsonLine(assistant)
check('assistant frame: usage extracted from message.usage', !!a && a.input_tokens === 100 && a.cache_read_input_tokens === 1000)
// CONTRACT FLIP: a result frame's usage
// is the turn's SUMMED API accounting (a 10-call turn at ~132k live ctx summed
// ~1.3M → read as 100% of a 1M window → spurious auto-clear mid-mission). It
// is NEVER live context — the parser must skip it.
const result = JSON.stringify({ type: 'result', usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 3 } })
check('result frame: usage IGNORED (per-turn summed accounting, not live context)', parseUsageFromStreamJsonLine(result) === null)
const summedResult = JSON.stringify({ type: 'result', usage: { input_tokens: 4, cache_creation_input_tokens: 700_000, cache_read_input_tokens: 600_000 } })
check('summed result frame (>window) ⇒ null, never a clamped-100% ctx', parseUsageFromStreamJsonLine(summedResult) === null)
check('non-JSON line ⇒ null', parseUsageFromStreamJsonLine('hello world') === null)
check('JSON without usage ⇒ null', parseUsageFromStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init' })) === null)
check('empty line ⇒ null', parseUsageFromStreamJsonLine('') === null)
const partial = parseUsageFromStreamJsonLine(JSON.stringify({ usage: { input_tokens: 42 } }))
check('partial usage: absent counts default to 0', !!partial && partial.input_tokens === 42 && partial.cache_creation_input_tokens === 0)

section('(a2) end-to-end → a sane 0-100 context %')
const win = getContextWindowForModel('claude-opus-4-8[1m]')
const pct = calculateContextPercentages(a!, win).used
check('context % is an integer in [0,100]', typeof pct === 'number' && pct! >= 0 && pct! <= 100, `pct=${pct} window=${win}`)

section('(b) WireRosterEntry telemetry fields (protocol.ts)')
const proto = src('daemon', 'protocol.ts')
check('WireRosterEntry has optional model/effort(+pending)/respawns/contextPct', /model\?:\s*string[\s\S]{0,300}effort\?:\s*string[\s\S]{0,600}pendingModel\?:\s*string[\s\S]{0,200}pendingEffort\?:\s*string[\s\S]{0,300}respawns\?:\s*number[\s\S]{0,300}contextPct\?:\s*number/.test(proto))

section('(c) roster populates + parses (roster.ts)')
const roster = src('daemon', 'roster.ts')
// display truth: list() derives model/effort via deriveWireSpec over
// the running-vs-spec split — the cells are RUNNING truth, never the patched spec.
check('list() derives model/effort via deriveWireSpec (running truth) + respawns', /deriveWireSpec\(\{[\s\S]{0,300}e\.model = wire\.model[\s\S]{0,450}e\.respawns = h\.longLived\.respawns/.test(roster))
check('list() surfaces contextPct when present', /e\.contextPct = h\.longLived\.contextPct/.test(roster))
check('WireRosterEntry carries busy (#25 true-idle)', /busy\?:\s*boolean/.test(proto))
check('list() emits busy from seatIsIdle (#25)', /e\.busy = !this\.seatIsIdle\(h\.longLived\)/.test(roster))
check('spawnLongLived parses drained stdout for usage (not just discards)', /usageOfStreamJsonFrame\(frame\)[\s\S]{0,200}calculateContextPercentages/.test(roster))
check('LongLivedState carries contextPct', /contextPct\?:\s*number/.test(roster))

section('(d) daemonRosterSnapshot (utils/cockpit)')
const snap = src('utils', 'cockpit', 'daemonRosterSnapshot.ts')
check('issues a list RPC', /daemonControlRpc\(\{\s*op:\s*'list'/.test(snap))
check('finds the worker entry by short (default implementer)', /short = 'implementer'[\s\S]{0,400}jobs\.find\(j => j\.short === short\)/.test(snap))
check('never throws (try/catch → {ok:false})', /catch \(e\)[\s\S]{0,120}ok:\s*false/.test(snap))
check('exported from utils/cockpit/index.ts', /daemonRosterSnapshot/.test(src('utils', 'cockpit', 'index.ts')))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TELEMETRY CHECKS PASS')
else console.log(`❌ ${failures} TELEMETRY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
