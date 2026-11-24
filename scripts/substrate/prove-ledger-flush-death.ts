#!/usr/bin/env bun
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

const trace = await import('../../src/platform/observability/invocationTrace.ts')
const clock = await import('../../src/platform/cache-clock/cacheClock.ts')
import type { Tool } from '../../src/tools/kit/tool.js'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
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
  mkdirSync(tracePath, { recursive: true })
  trace.emitInvocationTrace(fakeTool, { durationMs: 5, ok: true })
  trace.emitInvocationTrace(fakeTool, { durationMs: 6, ok: false })
  check('records buffer before any flush', trace.getTraceFlushHealth().pending === 2, '', 'emitInvocationTrace in src/platform/observability/invocationTrace.ts must queue each record in the pending buffer until flushTraceNow runs')
  await trace.flushTraceNow()
  let h = trace.getTraceFlushHealth()
  check('failed flush RETAINS both records', h.pending === 2, `pending=${h.pending}`, 'flushTraceNow in src/platform/observability/invocationTrace.ts must put the snapshot back in the pending buffer when appendFile fails')
  check('streak counts the failure', h.streak === 1, '', 'flushTraceNow in src/platform/observability/invocationTrace.ts must add one to the failure streak on each failed append')
  check('failure detail recorded', h.lastFailure !== null, '', 'flushTraceNow in src/platform/observability/invocationTrace.ts must set lastFailure when appendFile fails')
  await trace.flushTraceNow()
  await trace.flushTraceNow()
  h = trace.getTraceFlushHealth()
  check('streak reaches the escalation mark (3)', h.streak === 3, `streak=${h.streak}`, 'flushTraceNow in src/platform/observability/invocationTrace.ts must count every failed flush in the streak and keep counting')
  {
    const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
    const says = await crewChecks().find(row => row.id === 'invocation-trace')?.run()
    const named = /^mercury-trace\.jsonl flush failing — streak (\d+), (\d+) pending/.exec(says?.evidence ?? '')
    check('the /health trace row reads that streak from the owner: warn, the streak and the pending count named', says?.status === 'warn' && named !== null && Number(named[1]) >= h.streak && Number(named[1]) <= trace.getTraceFlushHealth().streak && Number(named[2]) === h.pending, `${says?.status}: ${says?.evidence.slice(0, 70)}`, 'the invocation-trace row in src/platform/health/sections/crew/boot.ts must report warn with the text mercury-trace.jsonl flush failing, the streak and the pending count read from getTraceFlushHealth')
  }
  check('nothing landed on the occupied path', diskLines().length === 0, '', 'the trace path was made a directory in this proof; check that flushTraceNow in src/platform/observability/invocationTrace.ts does not write elsewhere')
}

section('§2 invocation trace — recovery lands everything in order')
{
  rmSync(tracePath, { recursive: true, force: true })
  trace.emitFoldTrace('microcompact', { tokensFreed: 1234 })
  await trace.flushTraceNow()
  const h = trace.getTraceFlushHealth()
  check('recovered flush drains the buffer', h.pending === 0, '', 'flushTraceNow in src/platform/observability/invocationTrace.ts must empty the pending buffer after a successful append')
  check('streak resets on success', h.streak === 0, '', 'flushTraceNow in src/platform/observability/invocationTrace.ts must set the failure streak back to 0 after a successful append')
  check('lastWriteOkAt stamped', h.lastWriteOkAt !== null, '', 'flushTraceNow in src/platform/observability/invocationTrace.ts must set lastWriteOkAt after a successful append')
  const lines = diskLines().map(l => JSON.parse(l))
  check('EVERY record landed (2 invocations + 1 compaction)', lines.length === 3, `${lines.length}`, 'flushTraceNow in src/platform/observability/invocationTrace.ts must write every retained record, plus the compaction record from emitCompactionTrace, on the first good flush')
  check(
    'order held: the pre-failure records lead, the compaction record trails',
    lines[0]?.tool === 'ProofTool' && lines[1]?.tool === 'ProofTool' && lines[2]?.kind === 'compaction',
    '',
    'flushTraceNow in src/platform/observability/invocationTrace.ts must put retained records back in front of newer ones, so the file keeps emit order',
  )
}

section('§3 invocation trace — bounded buffer drops oldest, counted')
{
  trace._resetTraceFlushForTesting()
  rmSync(tracePath, { recursive: true, force: true })
  mkdirSync(tracePath, { recursive: true })
  const CAP = 2_000
  for (let i = 0; i < CAP + 50; i++) {
    trace.emitInvocationTrace(fakeTool, { durationMs: i })
  }
  const h = trace.getTraceFlushHealth()
  check('pending bounded at the cap', h.pending === CAP, `pending=${h.pending}`, 'the buffer trim against TRACE_PENDING_CAP in src/platform/observability/invocationTrace.ts must keep the newest 2000 records')
  check('overflow counted as dropped', h.dropped === 50, `dropped=${h.dropped}`, 'the buffer trim against TRACE_PENDING_CAP in src/platform/observability/invocationTrace.ts must add the number of discarded records to droppedLines')
  rmSync(tracePath, { recursive: true, force: true })
  trace._resetTraceFlushForTesting()
}

section('§4 cache-clock rollups — counted streak + recovery')
{
  clock.resetCacheClockForTesting()
  const decision = clock.cacheClockTtlDecision({ eligible: true, lastCompletionAt: null, now: Date.now() })
  check('clock latched in the scratch home', decision !== null, String(decision), 'cacheClockTtlDecision in src/platform/cache-clock/cacheClock.ts returned null in the scratch config home; check what makes it latch')
  const snap = clock.cacheClockSnapshot()
  check('snapshot reports engaged', snap.engaged === true, '', 'cacheClockSnapshot in src/platform/cache-clock/cacheClock.ts must report engaged once cacheClockTtlDecision has latched')
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
  observe()
  let ch = clock.getCacheClockFlushHealth()
  check('healthy rollup stamps lastRollupOkAt', ch.lastRollupOkAt !== null && ch.streak === 0, '', 'cacheClockObserve or flushCacheClockNow in src/platform/cache-clock/cacheClock.ts must stamp lastRollupOkAt after a good rollup write')
  const projectsRoot = join(HOME, 'projects')
  const sessionsDirs = ((): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      let names: string[] = []
      try {
        names = readFileSync(d) ? [] : []
      } catch {
      }
      try {
        for (const n of require('node:fs').readdirSync(d)) {
          const p = join(d, n)
          if (n === 'sessions') out.push(p)
          else if (require('node:fs').statSync(p).isDirectory()) walk(p)
        }
      } catch {
      }
    }
    walk(projectsRoot)
    return out
  })()
  check('found the scratch sessions dir', sessionsDirs.length === 1, sessionsDirs.join(','), 'the rollup write in src/platform/cache-clock/cacheClock.ts should create exactly one sessions directory under the scratch projects folder')
  const sess = sessionsDirs[0]!
  rmSync(sess, { recursive: true, force: true })
  writeFileSync(sess, 'occupied')
  clock.flushCacheClockNow()
  clock.flushCacheClockNow()
  clock.flushCacheClockNow()
  ch = clock.getCacheClockFlushHealth()
  check('rollup failures count a streak (≥3 escalates)', ch.streak >= 3, `streak=${ch.streak}`, 'flushCacheClockNow in src/platform/cache-clock/cacheClock.ts must count each failed rollup write in the streak')
  {
    const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
    const says = await crewChecks().find(row => row.id === 'cache-clock')?.run()
    const named = /^session rollup writes failing — streak (\d+): /.exec(says?.evidence ?? '')
    check('the /health metering row reads that streak from the owner: warn, the streak named', says?.status === 'warn' && named !== null && Number(named[1]) >= ch.streak && Number(named[1]) <= clock.getCacheClockFlushHealth().streak, `${says?.status}: ${says?.evidence.slice(0, 70)}`, 'the cache-clock row in src/platform/health/sections/crew/appends.ts must report warn with the text session rollup writes failing and the streak read from getCacheClockFlushHealth')
  }
  check('failure detail recorded', ch.lastFailure !== null, '', 'flushCacheClockNow in src/platform/cache-clock/cacheClock.ts must set lastFailure when the rollup write fails')
  rmSync(sess, { force: true })
  clock.flushCacheClockNow()
  ch = clock.getCacheClockFlushHealth()
  check('healed flush clears the streak', ch.streak === 0, '', 'flushCacheClockNow in src/platform/cache-clock/cacheClock.ts must set the streak back to 0 after a good rollup write')
  const rollups = require('node:fs').readdirSync(sess).filter((f: string) => f.endsWith('.json'))
  check('rollup landed after heal', rollups.length === 1, rollups.join(','), 'flushCacheClockNow in src/platform/cache-clock/cacheClock.ts must write one rollup json file once the sessions directory is usable again')
  clock.resetCacheClockForTesting()
}

section('§5 wiring anchors')
{
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const crewRows = crewChecks()
  check(
    '/health carries freshness probes for all three ledgers',
    ['history', 'invocation-trace', 'cache-clock'].every(id => crewRows.filter(row => row.id === id).length === 1),
    '',
    'crewChecks must return exactly one row each for history, invocation-trace and cache-clock; the rows live under src/platform/health/sections/crew',
  )
  const traceOwner = await import('../../src/platform/observability/invocationTrace.ts')
  const clockOwner = await import('../../src/platform/cache-clock/cacheClock.ts')
  const traceSays = await crewRows.find(row => row.id === 'invocation-trace')?.run()
  const traceHealth = traceOwner.getTraceFlushHealth()
  const clockSays = await crewRows.find(row => row.id === 'cache-clock')?.run()
  const clockSnap = clockOwner.cacheClockSnapshot()
  const clockHealth = clockOwner.getCacheClockFlushHealth()
  check(
    'the health probes read the owners’ health accessors',
    traceSays !== undefined && (!traceOwner.isInvocationTraceEnabled() ? traceSays.status === 'off' : traceHealth.streak >= 3 ? traceSays.status === 'warn' && traceSays.evidence.includes(`streak ${traceHealth.streak}`) : traceSays.status === 'ok' && traceSays.evidence.startsWith(traceHealth.pending === 0 ? 'appends healthy' : `${traceHealth.pending} pending`)) &&
      clockSays !== undefined && (!clockSnap.engaged ? clockSays.status === 'off' : clockHealth.streak >= 3 ? clockSays.status === 'warn' && clockSays.evidence.includes(`streak ${clockHealth.streak}`) : clockSays.status === 'ok'),
    `${traceSays?.evidence} | ${clockSays?.evidence}`,
    'the invocation-trace row in src/platform/health/sections/crew/boot.ts and the cache-clock row in src/platform/health/sections/crew/appends.ts must take status and evidence from getTraceFlushHealth and getCacheClockFlushHealth',
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-ledger-flush-death: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ledger-flush-death: all green')
