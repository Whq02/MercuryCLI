#!/usr/bin/env bun

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

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const dir = mkdtempSync(join(tmpdir(), 'mercury-trace-once-'))
process.env.MERCURY_CONFIG_DIR = dir
process.env.MERCURY_TRACE = '1'

const { emitInvocationTrace, getInvocationTracePath } = await import(
  '../../src/utils/observability/invocationTrace.js'
)

const fakeTool = { name: 'Bash' } as unknown as Parameters<typeof emitInvocationTrace>[0]

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

section('collapse: an EARLIER emit is collapsed — the finally never doubles it')
{
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-trace-once-collapse-'))
  const traceOnce = makeTraceOnce()
  traceOnce({ ok: false })
  traceOnce({ durationMs: 999, ok: true })
  traceOnce({ killed: true, ok: false })
  await sleep(120)
  const recs = readRecords()
  check('still exactly ONE record (later emits collapsed)', recs.length === 1, `${recs.length} records`)
  const r = recs[0] ?? {}
  check('the FIRST emit won (ok:false, no durationMs, not killed)', r.ok === false && !('durationMs' in r) && !('killed' in r))
}

section('bare-stamp OR fully-off ⇒ traceOnce emits nothing')
{
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-trace-once-off-'))
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
