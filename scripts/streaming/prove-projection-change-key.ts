#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'projection-key-home-'))
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const connector = await import(join(ROOT, 'src/engine/connector/daemonConnector.ts'))
const { projectionChangeKey, ProjectionFeed } = connector as {
  projectionChangeKey: (stat: { mtimeMs: number; size: number; ino: number }) => string
  ProjectionFeed: new (dir: string, path: string, onChange: () => void) => { start(): void; stop(): void }
}

section('§1 the pure key')
{
  const base = { mtimeMs: 1_700_000_000_000, size: 120, ino: 4242 }
  check('an identical stat keys identical', projectionChangeKey(base) === projectionChangeKey({ ...base }), 'projectionChangeKey in src/engine/connector/projectionFeed.ts must build the key only from mtimeMs, size and ino')
  check('the size breaks an mtime tie (the tail\'s text publish then its clear)', projectionChangeKey(base) !== projectionChangeKey({ ...base, size: 12 }), 'projectionChangeKey in src/engine/connector/projectionFeed.ts must include stat.size in the key')
  check('the inode breaks an mtime+size tie (a fresh file per publish)', projectionChangeKey(base) !== projectionChangeKey({ ...base, ino: 4243 }), 'projectionChangeKey in src/engine/connector/projectionFeed.ts must include stat.ino in the key')
  check('the mtime still counts on its own', projectionChangeKey(base) !== projectionChangeKey({ ...base, mtimeMs: base.mtimeMs + 1 }), 'projectionChangeKey in src/engine/connector/projectionFeed.ts must include stat.mtimeMs in the key')
}

section('§2 THE DEFECT PIN, live: two publishes, one mtime, two changes')
{
  const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'projection-feed-'))
  const path = join(dir, 'tail.json')
  let changes = 0
  const feed = new ProjectionFeed(dir, path, () => {
    changes++
  })
  let publishes = 0
  const publish = (bytes: string, mtime?: Date): void => {
    const tmp = `${path}.${process.pid}.${++publishes}.tmp`
    writeFileSync(tmp, bytes)
    if (mtime !== undefined) utimesSync(tmp, mtime, mtime)
    renameSync(tmp, path)
  }
  const waitFor = async (want: number, budgetMs = 1500): Promise<boolean> => {
    const until = Date.now() + budgetMs
    while (Date.now() < until) {
      if (changes >= want) return true
      await new Promise(r => setTimeout(r, 25))
    }
    return changes >= want
  }
  feed.start()
  check('an absent file is no change', changes === 0, `changes ${changes}; ProjectionFeed.start in src/engine/connector/projectionFeed.ts must not call onChange while the file is absent (tick compares against PROJECTION_ABSENT)`)
  const tie = new Date(Math.floor(Date.now() / 1000) * 1000)
  publish('{"text":"Hello"}\n', tie)
  check('the first publish fires onChange', await waitFor(1), `changes ${changes}; ProjectionFeed in src/engine/connector/projectionFeed.ts must call onChange when the file appears (armWatcher, tick)`)
  const first = statSync(path)
  publish('{"text":null}\n', tie)
  const second = statSync(path)
  check('CONTROL (the disease\'s condition): the pair carries ONE mtime on this filesystem', second.mtimeMs === first.mtimeMs, `${first.mtimeMs} vs ${second.mtimeMs}; the test fixture cannot pin one mtime on this filesystem, so the scratch directory under SCRATCHPAD or the OS temp dir needs a filesystem that keeps the utimesSync time`)
  check('…and the sizes differ (the term that tells the pair apart)', second.size !== first.size, `${first.size} vs ${second.size}; the two publish payloads in this section must differ in byte length`)
  check('THE DEFECT PIN: the same-mtime, different-size publish fires onChange', await waitFor(2), `changes ${changes}; projectionChangeKey and ProjectionFeed.tick in src/engine/connector/projectionFeed.ts must treat a size change at an equal mtime as a change`)
  publish('{"text":"Hi"}\n', tie)
  const third = statSync(path)
  check('fixture: the third publish is equal-size and same-tick', third.size === second.size && third.mtimeMs === second.mtimeMs, `${second.size}/${second.mtimeMs} vs ${third.size}/${third.mtimeMs}; the third publish payload in this section must keep the second payload byte length`)
  if (third.ino !== second.ino) {
    check('a same-mtime same-size republish fires onChange (the inode moved with the rename)', await waitFor(3), `changes ${changes}; projectionChangeKey in src/engine/connector/projectionFeed.ts must include stat.ino so a renamed-in file with equal mtime and size still counts`)
  } else {
    console.log('  [NOTE] this filesystem reused the inode across the rename — the inode term is inert here (not a failure)')
  }
  const before = changes
  await new Promise(r => setTimeout(r, 900))
  check('no publish, no change (the heartbeat is idempotent per key)', changes === before, `changes ${changes} vs ${before}; ProjectionFeed.tick in src/engine/connector/projectionFeed.ts must call onChange only when the key differs from lastKey`)
  feed.stop()
  rmSync(dir, { recursive: true, force: true })
}


section('§3 the settle window ends on a clock nothing can step, and a stop takes its timer with it')
{
  type Settling = { start(): void; stop(): void; settle(windowMs: number): void; heartbeatMs(): number }
  const Feed = ProjectionFeed as unknown as new (dir: string, path: string, onChange: () => void, idleFloorMs: () => number) => Settling
  const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'projection-settle-'))
  const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const feed = new Feed(dir, join(dir, 'facts.json'), () => {}, () => 10_000)
  feed.start()
  check('an idle feed that has its watcher beats at its idle floor', feed.heartbeatMs() === 10_000, `${feed.heartbeatMs()}; ProjectionFeed.cadenceMs in src/engine/connector/projectionFeed.ts must return idleFloorMs() when the watcher is armed and no settle window is open`)
  feed.settle(300)
  check('a settle window brings the 400 ms heartbeat', feed.heartbeatMs() === 400, `${feed.heartbeatMs()}; ProjectionFeed.settle and cadenceMs in src/engine/connector/projectionFeed.ts must drop the cadence to HEARTBEAT_MS during a settle window`)
  const wallClock = Date.now
  Date.now = () => wallClock() - 3_600_000
  await pause(700)
  Date.now = wallClock
  check('a wall clock stepped back an hour inside the window still falls back to the idle floor', feed.heartbeatMs() === 10_000, `${feed.heartbeatMs()}; ProjectionFeed in src/engine/connector/projectionFeed.ts must end the settle window on performance.now(), not Date.now()`)
  feed.settle(200)
  feed.settle(600)
  await pause(350)
  check('control: of two windows the later end holds the heartbeat', feed.heartbeatMs() === 400, `${feed.heartbeatMs()}; ProjectionFeed.settle in src/engine/connector/projectionFeed.ts must keep the later of the two window ends (Math.max on settleUntilMs)`)
  await pause(500)
  check('control: …and the floor comes back when it has passed', feed.heartbeatMs() === 10_000, `${feed.heartbeatMs()}; ProjectionFeed.revertWhenSettled in src/engine/connector/projectionFeed.ts must rearm to the idle floor once settleUntilMs has passed`)
  const alive = new Set<unknown>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSet(...args)
    alive.add(handle)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    alive.delete(handle)
    realClear(handle)
  }) as typeof clearTimeout
  let made = 0
  try {
    feed.settle(5_000)
    made = alive.size
    feed.stop()
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  check('the rig holds: the settle made a timeout of its own', made >= 1, `${made}; the rig wraps globalThis.setTimeout, so ProjectionFeed.settle in src/engine/connector/projectionFeed.ts must schedule its revert timer through a setTimeout the rig can see`)
  check('a stop inside the window leaves no timeout of the feed behind', alive.size === 0, `${alive.size}; ProjectionFeed.stop in src/engine/connector/projectionFeed.ts must clear the revert timer that settle started`)
  for (const handle of alive) realClear(handle as Parameters<typeof clearTimeout>[0])
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-projection-change-key: ALL LAWS HOLD' : `\nprove-projection-change-key: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
