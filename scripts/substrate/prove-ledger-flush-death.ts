#!/usr/bin/env bun
// prove-ledger-flush-death — K7's flush-death law extended to the OTHER
// two ledger writers (the history owner keeps its own prover):
//
//   invocationTrace (mercury-trace.jsonl) — bounded pending
//   buffer, snapshot-and-requeue on failure, streak-3 escalation, drop-oldest
//   cap counted honestly, teardown attempt + notice, /doctor health.
//     §1 INJECTION: sidecar path is a DIRECTORY ⇒ flushes fail, entries are
//        RETAINED in order, the streak climbs to the escalation mark.
//     §2 RECOVERY: heal the path ⇒ one flush lands EVERY line in order;
//        streak 0, lastWriteOkAt stamped; the compaction lane rides the
//        SAME buffer.
//     §3 BOUNDED BUFFER: overflow drops the OLDEST lines and counts them.
//
//   cacheClock rollups — a whole-state snapshot (memory IS the buffer; a
//   failed write loses nothing) whose failures were a bare fail-open catch.
//     §4 INJECTION: sessions dir path occupied by a FILE ⇒ rollup writes
//        fail with a counted streak; heal ⇒ flushCacheClockNow lands the
//        rollup and clears the streak.
//
//   §5 WIRING: /doctor carries the two new probes; the emitters enqueue
//      (never bare appendFile); teardown registration exists for both.
//
// Hermetic: config home is a temp dir set BEFORE the module loads; the
// cache-clock sessions dir derives from the same scratch home. Counted
// wakeups only (the granted-time law) — no wall-clock windows.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ledger-flush-death-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TRACE = '1'
delete process.env.MERCURY_TRACE
delete process.env.MERCURY_CACHE_CLOCK
delete process.env.MERCURY_CACHE_TTL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const trace = await import('../../src/utils/observability/invocationTrace.ts')
const clock = await import('../../src/utils/cache/cacheClock.ts')
import type { Tool } from '../../src/Tool.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const tracePath = trace.getInvocationTracePath()
const fakeTool = { name: 'ProofTool' } as unknown as Tool
const diskLines = (): string[] => {
  try {
    return readFileSync(tracePath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

section('§1 invocation trace — injection: unwritable sidecar retains + escalates')
{
  trace._resetTraceFlushForTesting()
  // The sidecar path occupied by a DIRECTORY ⇒ every append fails (EISDIR).
  mkdirSync(tracePath, { recursive: true })
  trace.emitInvocationTrace(fakeTool, { durationMs: 5, ok: true })
  trace.emitInvocationTrace(fakeTool, { durationMs: 6, ok: false })
  check('records buffer before any flush', trace.getTraceFlushHealth().pending === 2)
  await trace.flushTraceNow()
  let h = trace.getTraceFlushHealth()
  check('failed flush RETAINS both records', h.pending === 2, `pending=${h.pending}`)
  check('streak counts the failure', h.streak === 1)
  check('failure detail recorded', h.lastFailure !== null)
  await trace.flushTraceNow()
  await trace.flushTraceNow()
  h = trace.getTraceFlushHealth()
  check('streak reaches the escalation mark (3)', h.streak === 3, `streak=${h.streak}`)
  check('nothing landed on the occupied path', diskLines().length === 0)
}

section('§2 invocation trace — recovery lands everything in order')
{
  rmSync(tracePath, { recursive: true, force: true })
  // The compaction lane rides the SAME buffer (order preserved).
  trace.emitCompactionTrace('microcompact', { tokensFreed: 1234 })
  await trace.flushTraceNow()
  const h = trace.getTraceFlushHealth()
  check('recovered flush drains the buffer', h.pending === 0)
  check('streak resets on success', h.streak === 0)
  check('lastWriteOkAt stamped', h.lastWriteOkAt !== null)
  const lines = diskLines().map(l => JSON.parse(l))
  check('EVERY record landed (2 invocations + 1 compaction)', lines.length === 3, `${lines.length}`)
  check(
    'order held: the pre-failure records lead, the compaction record trails',
    lines[0]?.tool === 'ProofTool' && lines[1]?.tool === 'ProofTool' && lines[2]?.kind === 'compaction',
  )
}

section('§3 invocation trace — bounded buffer drops oldest, counted')
{
  trace._resetTraceFlushForTesting()
  rmSync(tracePath, { recursive: true, force: true }) // §2 healed it into a FILE
  mkdirSync(tracePath, { recursive: true })
  const CAP = 2_000
  for (let i = 0; i < CAP + 50; i++) {
    trace.emitInvocationTrace(fakeTool, { durationMs: i })
  }
  const h = trace.getTraceFlushHealth()
  check('pending bounded at the cap', h.pending === CAP, `pending=${h.pending}`)
  check('overflow counted as dropped', h.dropped === 50, `dropped=${h.dropped}`)
  rmSync(tracePath, { recursive: true, force: true })
  trace._resetTraceFlushForTesting()
}

section('§4 cache-clock rollups — counted streak + recovery')
{
  clock.resetCacheClockForTesting()
  // Latch the clock in the scratch home, then OCCUPY the sessions-dir path
  // with a file so mkdirSync inside the rollup write throws.
  const decision = clock.cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: Date.now() })
  check('clock latched in the scratch home', decision !== null, String(decision))
  const snap = clock.cacheClockSnapshot()
  check('snapshot reports engaged', snap.engaged === true)
  // Find the sessions dir via the health-flush path: force one OK rollup
  // first so the dir exists, then break it.
  const observe = () =>
    clock.cacheClockObserve({
      cacheReadTokens: 10,
      cacheCreationTotal: 5,
      cacheCreation5m: null,
      cacheCreation1h: null,
      uncachedInputTokens: 1,
      now: Date.now(),
    })
  observe()
  observe()
  observe() // 3rd request ⇒ first rollup flush
  let ch = clock.getCacheClockFlushHealth()
  check('healthy rollup stamps lastRollupOkAt', ch.lastRollupOkAt !== null && ch.streak === 0)
  // Break: replace the sessions DIR with a file (mkdirSync now throws ENOTDIR/EEXIST).
  const projectsRoot = join(HOME, 'projects')
  const sessionsDirs = ((): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      let names: string[] = []
      try {
        names = readFileSync(d) ? [] : []
      } catch {
        /* not a file — enumerate below */
      }
      try {
        for (const n of require('node:fs').readdirSync(d)) {
          const p = join(d, n)
          if (n === 'sessions') out.push(p)
          else if (require('node:fs').statSync(p).isDirectory()) walk(p)
        }
      } catch {
        /* leaf */
      }
    }
    walk(projectsRoot)
    return out
  })()
  check('found the scratch sessions dir', sessionsDirs.length === 1, sessionsDirs.join(','))
  const sess = sessionsDirs[0]!
  rmSync(sess, { recursive: true, force: true })
  writeFileSync(sess, 'occupied') // a FILE where the dir must be
  clock.flushCacheClockNow()
  clock.flushCacheClockNow()
  clock.flushCacheClockNow()
  ch = clock.getCacheClockFlushHealth()
  check('rollup failures count a streak (≥3 escalates)', ch.streak >= 3, `streak=${ch.streak}`)
  check('failure detail recorded', ch.lastFailure !== null)
  // Heal ⇒ one flush lands the rollup and clears the streak.
  rmSync(sess, { force: true })
  clock.flushCacheClockNow()
  ch = clock.getCacheClockFlushHealth()
  check('healed flush clears the streak', ch.streak === 0)
  const rollups = require('node:fs').readdirSync(sess).filter((f: string) => f.endsWith('.json'))
  check('rollup landed after heal', rollups.length === 1, rollups.join(','))
  clock.resetCacheClockForTesting()
}

section('§5 wiring anchors')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  const traceTs = src('src/utils/observability/invocationTrace.ts')
  check(
    'emitters enqueue — no bare fire-and-forget appendFile remains',
    !/appendFile\([^)]*\(\)\s*=>\s*\{\s*\}\)/.test(traceTs) && (traceTs.match(/enqueueTraceLine\(/g) || []).length >= 3,
  )
  check('trace teardown registers one final attempt + notice', traceTs.includes('registerCleanup(') && traceTs.includes('unflushed'))
  const clockTs = src('src/utils/cache/cacheClock.ts')
  check('cache-clock teardown registers one final attempt + notice', clockTs.includes('registerCleanup(') && clockTs.includes('unflushed'))
  const doctorTs = src('src/utils/healthReport.ts')
  check(
    '/doctor carries freshness probes for all three ledgers',
    doctorTs.includes("id: 'history'") &&
      doctorTs.includes("id: 'invocation-trace'") &&
      doctorTs.includes("id: 'cache-clock'"),
  )
  check(
    'the doctor probes read the owners’ health accessors',
    doctorTs.includes('getTraceFlushHealth') && doctorTs.includes('getCacheClockFlushHealth'),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-ledger-flush-death: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ledger-flush-death: all green')
