#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-trace-rotation.ts
//  PROOF: the invocation-trace sidecar is SIZE-BOUNDED now that it ships live by
//  default — maybeTrimTrace rewrites an over-cap file down to its last whole
//  records (atomically), preserving the most-recent lines and never corrupting
//  a record. Exercised against the REAL production code.
// ============================================================================

import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRACE_MAX_BYTES,
  TRACE_KEEP_BYTES,
  maybeTrimTrace,
} from '../../src/utils/observability/invocationTrace.js'
import { aggregateByTool } from '../../src/utils/cockpit/traceSnapshot.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Invocation-trace size-bounded rotation — proof')
console.log('============================================================\n')

const dir = mkdtempSync(join(tmpdir(), 'trace-rot-'))
const path = join(dir, 'mercury-trace.jsonl')

// Build a file comfortably over the cap with valid, numbered JSONL records.
const lines: string[] = []
let i = 0
while (true) {
  lines.push(JSON.stringify({ ts: '2026-06-17T00:00:00.000Z', tool: 'Bash', surface: 'builtin', risk: 'low', n: i }))
  i++
  if (lines.join('\n').length > TRACE_MAX_BYTES + 200_000) break
}
const original = lines.join('\n') + '\n'
writeFileSync(path, original)
const beforeSize = statSync(path).size
const lastN = i - 1
check('seeded file is over the cap', beforeSize > TRACE_MAX_BYTES, `${beforeSize} bytes, ${i} records`)

await maybeTrimTrace(path)

const after = readFileSync(path, 'utf-8')
const afterSize = Buffer.byteLength(after)
check('file shrank below the cap', afterSize <= TRACE_MAX_BYTES, `${afterSize} bytes`)
check('file kept roughly the last KEEP_BYTES (not emptied, not whole)', afterSize > 0 && afterSize <= TRACE_KEEP_BYTES + 1000 && afterSize < beforeSize)

const outLines = after.split('\n').filter(Boolean)
// every retained line is a WHOLE, parseable record (no partial leading line).
let allParse = true
let firstN = -1
let lastParsedN = -1
for (const l of outLines) {
  try {
    const rec = JSON.parse(l)
    if (firstN < 0) firstN = rec.n
    lastParsedN = rec.n
  } catch {
    allParse = false
    break
  }
}
check('every retained line is a whole parseable record (no partial first line)', allParse)
check('the MOST RECENT record is preserved', lastParsedN === lastN, `last kept n=${lastParsedN}, expected ${lastN}`)
check('the OLDEST records were dropped (retention is a tail)', firstN > 0, `first kept n=${firstN}`)

// idempotence: trimming an already-small file is a no-op.
const sizeBeforeNoop = statSync(path).size
await maybeTrimTrace(path)
check('trimming an under-cap file is a no-op', statSync(path).size === sizeBeforeNoop)

// ── aggregateByTool: the /trace per-tool breakdown ───────────────────────────
console.log('\n' + '─'.repeat(76) + '\n aggregateByTool — /trace per-tool rollup')
{
  const recs = [
    { ts: 't', tool: 'Bash', surface: 'builtin', risk: 'high', ok: true, durationMs: 100 },
    { ts: 't', tool: 'Bash', surface: 'builtin', risk: 'high', ok: true, durationMs: 300 },
    { ts: 't', tool: 'Bash', surface: 'builtin', risk: 'high', ok: false, durationMs: 200 },
    { ts: 't', tool: 'mcp__mercury__lease_list', surface: 'mcp:mercury', risk: 'low', killed: true },
    { ts: 't', tool: 'Read', surface: 'builtin', risk: 'low', ok: true, durationMs: 50 },
  ] as Parameters<typeof aggregateByTool>[0]
  const agg = aggregateByTool(recs)
  const bash = agg.find(a => a.tool === 'Bash')
  const lease = agg.find(a => a.tool === 'mcp__mercury__lease_list')
  check('sorted by count desc: Bash (3) is first', agg[0]?.tool === 'Bash')
  check('Bash count = 3', bash?.count === 3)
  check('Bash failed = 1 (ok:false counts)', bash?.failed === 1)
  check('Bash avg duration = 200ms ((100+300+200)/3)', bash?.avgDurationMs === 200)
  check('killed counts as failed (lease_list failed = 1)', lease?.failed === 1)
  check('a no-duration record ⇒ avg 0 (lease_list)', lease?.avgDurationMs === 0)
  check('surface/risk carried per tool (mcp:mercury)', lease?.surface === 'mcp:mercury' && lease?.risk === 'low')
  check('every record accounted for (3 distinct tools)', agg.length === 3)
  check('empty input ⇒ empty agg (never throws)', aggregateByTool([]).length === 0)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TRACE-ROTATION PROOFS PASS')
else console.log(`❌ ${failures} TRACE-ROTATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
