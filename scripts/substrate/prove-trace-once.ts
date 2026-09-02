#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-trace-once.ts
//  PROOF: the per-invocation trace COLLAPSES TO A SINGLE LINE across every exit
//  path of the universal tool-execution gate. checkPermissionsAndCallTool
//  (services/tools/toolExecution.ts) calls traceOnce() from SIX distinct exit
//  paths (killed, input-validation, validateInput-fail, pre-tool-hook stop,
//  permission-denied, executed finally), and the guarded closure must emit
//  AT MOST ONE record per invocation — the killed path one {killed:true,ok:false}
//  line, the executed path one line carrying durationMs+ok, and any earlier emit
//  is collapsed by the guard.
//
//  toolExecution.ts imports feature() from bun:bundle, so it is UNLOADABLE under
//  bun-run. We therefore drive the REAL emitter (emitInvocationTrace, exercised
//  on a real on-disk sidecar with a stamp-sim + tmp MERCURY_CONFIG_DIR — the same
//  method prove-compaction-trace.ts uses) through a VERBATIM reconstruction of
//  the traceOnce guard from toolExecution.ts:623-632. The guard is the invariant
//  under test; the emitter is real, so the on-disk record shape is real too.
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
const dir = mkdtempSync(join(tmpdir(), 'mercury-trace-once-'))
process.env.MERCURY_CONFIG_DIR = dir
process.env.MERCURY_TRACE = '1'

const { emitInvocationTrace, getInvocationTracePath } = await import(
  '../../src/utils/observability/invocationTrace.js'
)

// A minimal Tool stand-in: emitInvocationTrace → buildInvocationTrace →
// deriveCapabilityDescriptor degrades a partial tool to a safe-default
// descriptor, so a {name} object is enough to produce one honest record.
const fakeTool = { name: 'Bash' } as unknown as Parameters<typeof emitInvocationTrace>[0]

/**
 * VERBATIM reconstruction of the traceOnce guard at
 * services/tools/toolExecution.ts:623-632. One closure per simulated
 * invocation; the boolean latch makes every later call a no-op.
 */
function makeTraceOnce(): (opts: { killed?: boolean; durationMs?: number; ok?: boolean }) => void {
  let traceEmitted = false
  return (opts: { killed?: boolean; durationMs?: number; ok?: boolean }): void => {
    if (traceEmitted) return
    traceEmitted = true
    emitInvocationTrace(fakeTool, opts)
  }
}

function readRecords(): Array<Record<string, unknown>> {
  const path = getInvocationTracePath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

console.log('============================================================')
console.log(' trace single-emit collapse across gate exit paths — proof')
console.log('============================================================')

// ── the KILLED exit path (toolExecution.ts:644) ──────────────────────────────
section('killed path → exactly one {killed:true, ok:false} line')
{
  const traceOnce = makeTraceOnce()
  traceOnce({ killed: true, ok: false })
  await sleep(120)
  const recs = readRecords()
  check('exactly one record on disk', recs.length === 1, `${recs.length} records`)
  const r = recs[0] ?? {}
  check('record carries killed:true', r.killed === true)
  check('record carries ok:false', r.ok === false)
  check('killed record has NO durationMs (a killed call never ran)', !('durationMs' in r))
  check('record is the real shape (tool/surface/risk present)', typeof r.tool === 'string' && typeof r.surface === 'string' && typeof r.risk === 'string')
}

// ── the EXECUTED exit path (toolExecution.ts:1828, finally) ──────────────────
section('executed path → exactly one line with durationMs + ok')
{
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-trace-once-exec-'))
  const traceOnce = makeTraceOnce()
  traceOnce({ durationMs: 1234, ok: true })
  await sleep(120)
  const recs = readRecords()
  check('exactly one record on disk', recs.length === 1, `${recs.length} records`)
  const r = recs[0] ?? {}
  check('record carries durationMs (rounded, ≥0)', r.durationMs === 1234)
  check('record carries ok:true', r.ok === true)
  check('executed record is NOT marked killed', !('killed' in r))
}

// ── the COLLAPSE invariant: a second traceOnce after the first is a no-op ─────
// This is the whole point: 6 exit paths share ONE closure, so an early emit
// (e.g. a pre-tool-hook stop) followed by the executed finally must NOT double.
section('collapse: an EARLIER emit is collapsed — the finally never doubles it')
{
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-trace-once-collapse-'))
  const traceOnce = makeTraceOnce()
  // Simulate: a stop/permission path emitted {ok:false}, THEN the finally fires.
  traceOnce({ ok: false })
  traceOnce({ durationMs: 999, ok: true }) // the finally — must be a no-op
  traceOnce({ killed: true, ok: false }) // belt-and-suspenders third call
  await sleep(120)
  const recs = readRecords()
  check('still exactly ONE record (later emits collapsed)', recs.length === 1, `${recs.length} records`)
  const r = recs[0] ?? {}
  check('the FIRST emit won (ok:false, no durationMs, not killed)', r.ok === false && !('durationMs' in r) && !('killed' in r))
}

// ── OFF ⇒ no record at all (the cited zero-overhead claim, when truly off) ────
section('bare-stamp OR fully-off ⇒ traceOnce emits nothing')
{
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-trace-once-off-'))
  // The only TRUE no-op states: MERCURY_TRACE unset AND the substrate
  // umbrella off. (Trace is ON by default via the umbrella.)
  process.env.MERCURY_TRACE = '0'
  process.env.MERCURY_SUBSTRATE = '0'
  const traceOnce = makeTraceOnce()
  traceOnce({ killed: true, ok: false })
  traceOnce({ durationMs: 5, ok: true })
  await sleep(100)
  check('no sidecar written when fully off', !existsSync(getInvocationTracePath()))
  delete process.env.MERCURY_SUBSTRATE
  process.env.MERCURY_TRACE = '1'
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TRACE-ONCE PROOFS PASS')
else console.log(`❌ ${failures} TRACE-ONCE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
