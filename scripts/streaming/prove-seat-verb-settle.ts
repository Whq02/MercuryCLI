#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let liveWatchers = 0
const req = createRequire(import.meta.url)
const cjsFs = req('node:fs') as {
  watch: unknown
  mkdtempSync: (prefix: string) => string
  renameSync: (from: string, to: string) => void
  writeFileSync: (path: string, data: string) => void
}
const realWatch = cjsFs.watch
cjsFs.watch = (..._args: unknown[]) => {
  liveWatchers++
  const ee = new EventEmitter() as EventEmitter & { close: () => void }
  ee.close = () => {}
  return ee
}
syncBuiltinESMExports()
void realWatch
const { mkdtempSync, renameSync, writeFileSync } = cjsFs

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'seat-verb-settle-home-'))
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
let verbSeq = 0
const seqOf = (_verb: string): number => ++verbSeq

const connector = (await import(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'))) as {
  ProjectionFeed?: new (
    dir: string,
    path: string,
    onChange: () => void,
    idleFloorMs?: () => number,
  ) => { start(): void; stop(): void; heartbeatMs(): number; settle?: (windowMs: number) => void }
  HEARTBEAT_MS?: number
  SEAT_VERB_SETTLE_MS?: number
  IDLE_PROJECTION_FLOOR_MS?: number
}
const ProjectionFeed = connector.ProjectionFeed
const HEARTBEAT_MS = connector.HEARTBEAT_MS
const SEAT_VERB_SETTLE_MS = connector.SEAT_VERB_SETTLE_MS
const IDLE_FLOOR = connector.IDLE_PROJECTION_FLOOR_MS
if (ProjectionFeed === undefined) {
  console.log('  [FAIL] the connector exports ProjectionFeed')
  process.exit(1)
}

section('§1 the bounded window is a real number, at/above the heartbeat and under the idle floor')
check(
  'SEAT_VERB_SETTLE_MS is exported (the seat-verb nudge exists)',
  typeof SEAT_VERB_SETTLE_MS === 'number',
  `SEAT_VERB_SETTLE_MS=${String(SEAT_VERB_SETTLE_MS)} — absent ⇒ a missed watch event waits the idle floor`,
)
check('HEARTBEAT_MS is exported', typeof HEARTBEAT_MS === 'number', `HEARTBEAT_MS=${String(HEARTBEAT_MS)}`)
check('IDLE_PROJECTION_FLOOR_MS is exported', typeof IDLE_FLOOR === 'number', `IDLE_PROJECTION_FLOOR_MS=${String(IDLE_FLOOR)}`)
if (typeof SEAT_VERB_SETTLE_MS === 'number' && typeof HEARTBEAT_MS === 'number' && typeof IDLE_FLOOR === 'number') {
  check(
    'the window sits at/above the heartbeat and strictly under the idle floor (a bounded nudge, never a tighter steady floor)',
    SEAT_VERB_SETTLE_MS >= HEARTBEAT_MS && SEAT_VERB_SETTLE_MS < IDLE_FLOOR,
    `heartbeat ${HEARTBEAT_MS} ≤ ${SEAT_VERB_SETTLE_MS} < floor ${IDLE_FLOOR}`,
  )
}

section('§2 the cadence: at rest the idle floor; after a seat verb the heartbeat; then back')
{
  const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'seat-verb-cadence-'))
  const path = join(dir, 'facts.json')
  const FLOOR = 10_000
  const feed = new ProjectionFeed(dir, path, () => {}, () => FLOOR)
  feed.start()
  check('at rest, a live watcher ⇒ the feed heartbeats at the idle floor', feed.heartbeatMs() === FLOOR, `heartbeatMs=${feed.heartbeatMs()}`)
  if (typeof feed.settle === 'function' && typeof HEARTBEAT_MS === 'number' && typeof SEAT_VERB_SETTLE_MS === 'number') {
    feed.settle(SEAT_VERB_SETTLE_MS)
    check('after settle() the feed heartbeats at HEARTBEAT_MS (a missed watch event is caught within it, not at the idle floor)', feed.heartbeatMs() === HEARTBEAT_MS, `heartbeatMs=${feed.heartbeatMs()} want ${HEARTBEAT_MS}`)
    await sleep(SEAT_VERB_SETTLE_MS + 3 * HEARTBEAT_MS)
    check('after the window it reverts to the idle floor (bounded — the settled patience number is untouched)', feed.heartbeatMs() === FLOOR, `heartbeatMs=${feed.heartbeatMs()} want ${FLOOR}`)
  } else {
    check('the feed exposes settle() (the bounded seat-verb nudge)', false, 'settle() absent — the cadence stays at the idle floor after a seat verb')
  }
  feed.stop()
}

section('§3 THE DEFECT PIN, live: with the watch silent, a publish is read only via the nudge')
{
  const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'seat-verb-miss-'))
  const path = join(dir, 'facts.json')
  const FLOOR = 10_000
  let reads = 0
  const before = liveWatchers
  const feed = new ProjectionFeed(dir, path, () => { reads++ }, () => FLOOR)
  feed.start()
  check('the feed took a live (silent) watcher, so its cadence is the idle floor', liveWatchers > before && feed.heartbeatMs() === FLOOR, `watchers=${liveWatchers - before} heartbeatMs=${feed.heartbeatMs()}`)
  const publish = (n: number): void => {
    const tmp = `${path}.${process.pid}.${n}.tmp`
    writeFileSync(tmp, `{"schema":1,"n":${n}}\n`)
    renameSync(tmp, path)
  }
  const waitFor = async (want: number, budgetMs: number): Promise<boolean> => {
    const until = Date.now() + budgetMs
    while (Date.now() < until) {
      if (reads >= want) return true
      await sleep(20)
    }
    return reads >= want
  }
  const HB = typeof HEARTBEAT_MS === 'number' ? HEARTBEAT_MS : 400
  publish(1)
  const caughtWithoutNudge = await waitFor(1, 3 * HB)
  check("the disease's condition: with the watch silent, a publish is NOT read within a few heartbeats (it waits the idle floor)", !caughtWithoutNudge, `reads=${reads} within 3 heartbeats`)
  if (typeof feed.settle === 'function' && typeof SEAT_VERB_SETTLE_MS === 'number') {
    const baseline = reads
    feed.settle(SEAT_VERB_SETTLE_MS)
    publish(2)
    const caught = await waitFor(baseline + 1, 4 * HB)
    check('THE FIX: after a seat verb the nudge reads the missed publish within a few heartbeats (≪ the idle floor)', caught, `reads=${reads} within 4 heartbeats of settle()`)
  } else {
    check('THE FIX: the feed exposes settle() so the missed publish is read within the nudge', false, 'settle() absent — the publish waits the idle floor')
  }
  feed.stop()
}

section('§4 the seat verbs that arm the nudge: set-model and set-permission-mode beside set-effort')
{
  const { DaemonSessionConnector } = (await import(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'))) as {
    DaemonSessionConnector: new (record: unknown) => {
      setModel(setting: string | null): Promise<{ state: string }>
      setEffort(level: string): Promise<{ state: string }>
      setPermissionMode(mode: string): Promise<{ outcome: string }>
    }
  }
  const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'seat-verb-connector-'))
  const verbs: Array<{ verb: string; run: (c: Record<string, unknown>) => Promise<unknown>; expectedFlip: boolean }> = [
    { verb: 'set-effort (the control: armed since the effort chip fix)', run: c => (c as { setEffort: (l: string) => Promise<unknown> }).setEffort('low'), expectedFlip: true },
    { verb: 'set-model', run: c => (c as { setModel: (m: string) => Promise<unknown> }).setModel('claude-sonnet-5'), expectedFlip: true },
    { verb: 'set-permission-mode', run: c => (c as { setPermissionMode: (m: string) => Promise<unknown> }).setPermissionMode('strategy'), expectedFlip: true },
  ]
  for (const { verb, run, expectedFlip } of verbs) {
    const record = { schema: 1, sessionId: `aaaaaaaa-bbbb-4ccc-8ddd-${String(seqOf(verb)).padStart(12, '0')}`, home, workspaceId: home, isolation: 'exclusive', modelKey: 'claude-opus-5', effort: 'high', spawnedAt: Date.now(), lastLiveAt: Date.now() }
    const connector = new DaemonSessionConnector(record) as unknown as Record<string, unknown>
    const feed = connector.factsFeed as { start(): void; stop(): void; heartbeatMs(): number }
    connector.rpc = async () => ({ ok: true, outcome: 'applied' })
    feed.start()
    const before = feed.heartbeatMs()
    let outcome: unknown = null
    try {
      outcome = await run(connector)
    } catch (e) {
      outcome = `threw: ${e instanceof Error ? e.message : String(e)}`
    }
    const after = feed.heartbeatMs()
    check(`${verb}: the feed rests at the idle floor before the verb`, before === IDLE_FLOOR, `heartbeatMs=${before}`)
    check(`${verb}: the daemon answered applied through the stubbed door`, typeof outcome === 'object' && outcome !== null && ((outcome as { state?: string }).state === 'applied' || (outcome as { outcome?: string }).outcome === 'applied'), JSON.stringify(outcome))
    check(`${verb}: ${expectedFlip ? 'arms the nudge — the feed ticks at HEARTBEAT_MS for the settle window' : 'leaves the cadence'}`, expectedFlip ? after === HEARTBEAT_MS : after === before, `heartbeatMs before=${before} after=${after} (HEARTBEAT_MS ${String(HEARTBEAT_MS)}, floor ${String(IDLE_FLOOR)})`)
    feed.stop()
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(failures === 0 ? ' seat-verb settle: ALL LAWS HOLD' : ` seat-verb settle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
