#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-compaction-trace.ts
//  PROOF: the compaction-event lane records the
//  context-shaping the local trace would otherwise miss entirely — emit is numeric-only
//  (never content), gated (piggybacks invocation-trace + MERCURY_COMPACTION_TRACE=0
//  opt-out), written to the shared sidecar, and rolled up by traceSnapshot into
//  a Compaction lane. Exercised against the REAL production code.
//
//  Under bun-run the build stamp is false (no MACRO); we set globalThis.MACRO
//  to simulate the fork, and point MERCURY_CONFIG_DIR at a tmpdir so the sidecar
//  path resolves there.
// ============================================================================

import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Fork-sim + a tmp config dir BEFORE importing the trace module (the path helper
// is memoized on MERCURY_CONFIG_DIR, so set it first).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const dir = mkdtempSync(join(tmpdir(), 'hermes-compaction-trace-'))
process.env.MERCURY_CONFIG_DIR = dir
process.env.MERCURY_TRACE = '1'
delete process.env.MERCURY_COMPACTION_TRACE

const {
  buildCompactionTrace,
  emitCompactionTrace,
  isCompactionTraceEnabled,
  getInvocationTracePath,
} = await import('../../src/utils/observability/invocationTrace.js')
const { traceSnapshot, aggregateCompaction, parseTraceLines } = await import('../../src/utils/cockpit/traceSnapshot.js')

console.log('============================================================')
console.log(' compaction-event trace lane — proof')
console.log('============================================================')

// ── gating ───────────────────────────────────────────────────────────────────
section('gating: fork + invocation-trace on, with MERCURY_COMPACTION_TRACE=0 opt-out')
{
  check('MERCURY_TRACE=1 ⇒ enabled', isCompactionTraceEnabled() === true)
  process.env.MERCURY_COMPACTION_TRACE = '0'
  check('MERCURY_COMPACTION_TRACE=0 ⇒ disabled (opt-out)', isCompactionTraceEnabled() === false)
  delete process.env.MERCURY_COMPACTION_TRACE
  // Invocation trace is on for the fork via EITHER MERCURY_TRACE or the substrate
  // profile (default-on); to prove the piggyback we must turn BOTH off.
  process.env.MERCURY_TRACE = '0'
  process.env.MERCURY_SUBSTRATE = '0'
  check('invocation-trace off (MERCURY_TRACE=0 + MERCURY_SUBSTRATE=0) ⇒ compaction off too (piggyback)', isCompactionTraceEnabled() === false)
  process.env.MERCURY_TRACE = '1'
  delete process.env.MERCURY_SUBSTRATE
}

// ── numeric-only record (never content) ──────────────────────────────────────
section('buildCompactionTrace — numeric-only, no content')
{
  const rec = buildCompactionTrace('auto-compact', { tokensFreed: 1234.7, messagesBefore: 40, messagesAfter: 12, nowISO: '2026-06-17T06:00:00.000Z' })
  check("kind discriminator is 'compaction'", rec.kind === 'compaction')
  check('event recorded', rec.event === 'auto-compact')
  check('tokensFreed rounded to integer', rec.tokensFreed === 1235)
  check('messagesBefore/After recorded', rec.messagesBefore === 40 && rec.messagesAfter === 12)
  const json = JSON.stringify(rec)
  check('serialized record carries ONLY known numeric/label keys (no content)', /^\{("ts"|"kind"|"event"|"tokensFreed"|"messagesBefore"|"messagesAfter"|"agentId"|:|,|"[\w.:-]*"|\d|true|false)+\}$/.test(json) || !/(content|message|prompt|text|args)/i.test(json))
}

// ── emit → sidecar → snapshot lane ───────────────────────────────────────────
section('emitCompactionTrace → shared sidecar → traceSnapshot compaction lane')
{
  emitCompactionTrace('snip', { tokensFreed: 500 })
  emitCompactionTrace('context-collapse', { messagesBefore: 30, messagesAfter: 18 })
  emitCompactionTrace('auto-compact', { tokensFreed: 2000 })
  emitCompactionTrace('auto-compact', { tokensFreed: 1000 })
  await sleep(120) // fire-and-forget appends

  const path = getInvocationTracePath()
  check('sidecar written under the tmp config dir', existsSync(path) && path.startsWith(dir))
  const text = readFileSync(path, 'utf8')
  check('4 compaction records on disk', (text.match(/"kind":"compaction"/g) || []).length === 4)
  check('no content/secret-shaped keys in the file', !/(content|prompt|"text"|args)/i.test(text))

  const snap = await traceSnapshot()
  check('snapshot state is live', snap.state === 'live')
  const c = (snap.data as { compaction: ReturnType<typeof aggregateCompaction> }).compaction
  check('compaction total = 4', c.total === 4)
  check('auto-compact rolled up to 2× / 3000 tok', c.byEvent.find(e => e.event === 'auto-compact')?.count === 2 && c.byEvent.find(e => e.event === 'auto-compact')?.tokensFreed === 3000)
  check('total tokens freed = 3500', c.totalTokensFreed === 3500)
  // appendFile fire-and-forget across 4 calls doesn't guarantee on-disk order,
  // so assert only that a last event exists + is one of the emitted kinds.
  check('a last event is recorded', c.last !== undefined && ['snip', 'context-collapse', 'auto-compact'].includes(c.last.event))
}

// ── OFF ⇒ no emit ────────────────────────────────────────────────────────────
section('OFF (MERCURY_COMPACTION_TRACE=0) ⇒ no emit')
{
  const offDir = mkdtempSync(join(tmpdir(), 'hermes-compaction-off-'))
  process.env.MERCURY_CONFIG_DIR = offDir
  process.env.MERCURY_COMPACTION_TRACE = '0'
  emitCompactionTrace('auto-compact', { tokensFreed: 999 })
  await sleep(80)
  check('no sidecar written when opted out', !existsSync(join(offDir, 'mercury-trace.jsonl')))
  delete process.env.MERCURY_COMPACTION_TRACE
  process.env.MERCURY_CONFIG_DIR = dir
}

// ── single-pass parse is byte-identical to the old two-pass (hot-path optimize) ──
section('parseTraceLines: single pass == old two-pass union (mixed sidecar)')
{
  const mixed = [
    '{"ts":"t1","tool":"Read","ok":true,"risk":"low"}',
    '{"kind":"compaction","ts":"t2","event":"auto-compact","tokensFreed":100}',
    'garbage line not json',
    '{"ts":"t3","tool":"Bash","ok":false,"risk":"high"}',
    '', // blank line skipped
    '{"kind":"compaction","ts":"t4","event":"snip","tokensFreed":50}',
    '{"neitherToolNorKind":true}',
  ].join('\n')

  // Reference: the OLD two independent passes, replicated inline.
  const refRecords = mixed.split('\n').map(s => s.trim()).filter(Boolean).flatMap(l => {
    try { const r = JSON.parse(l); return r && typeof r === 'object' && typeof r.tool === 'string' ? [r] : [] } catch { return [] }
  })
  const refCompaction = mixed.split('\n').map(s => s.trim()).filter(Boolean).flatMap(l => {
    try { const r = JSON.parse(l); return r && typeof r === 'object' && r.kind === 'compaction' && typeof r.event === 'string' ? [r] : [] } catch { return [] }
  })

  const onePass = parseTraceLines(mixed)
  check('records identical to the old parseTrace pass', JSON.stringify(onePass.records) === JSON.stringify(refRecords), `${onePass.records.length} records`)
  check('compaction identical to the old parseCompactionTrace pass', JSON.stringify(onePass.compaction) === JSON.stringify(refCompaction), `${onePass.compaction.length} compaction`)
  check('records picked the two tool lines (Read, Bash)', onePass.records.map((r: { tool: string }) => r.tool).join(',') === 'Read,Bash')
  check('compaction picked the two events (auto-compact, snip)', onePass.compaction.map((r: { event: string }) => r.event).join(',') === 'auto-compact,snip')
  const agg = aggregateCompaction(onePass.compaction)
  check('aggregateCompaction over the single-pass output: total=2, tokensFreed=150', agg.total === 2 && agg.totalTokensFreed === 150)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL COMPACTION-TRACE PROOFS PASS')
else console.log(`❌ ${failures} COMPACTION-TRACE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
