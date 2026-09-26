#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'projection-twin-home-'))
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

const connector = (await import(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'))) as {
  ProjectionFeed: new (dir: string, path: string, onChange: () => void, idleFloorMs?: () => number) => { start(): void; stop(): void; heartbeatMs(): number }
  HEARTBEAT_MS: number
  IDLE_PROJECTION_FLOOR_MS: number
}
const { ProjectionFeed, HEARTBEAT_MS, IDLE_PROJECTION_FLOOR_MS } = connector
const SOON_MS = 5 * HEARTBEAT_MS
const NAME = '00000000-aaaa-bbbb-cccc-000000twin01.json'

const world = (): { watched: string; elsewhere: string; path: string } => {
  const root = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'projection-twin-'))
  const watched = join(root, 'session-facts')
  const elsewhere = join(root, 'landing')
  mkdirSync(watched)
  mkdirSync(elsewhere)
  return { watched, elsewhere, path: join(elsewhere, NAME) }
}

section('§1 the watcher reports the publish by its twin alone: the feed reads the publish within a few heartbeats, never at the idle floor')
{
  const w = world()
  let reads = 0
  const feed = new ProjectionFeed(w.watched, w.path, () => reads++, () => IDLE_PROJECTION_FLOOR_MS)
  feed.start()
  await sleep(2 * HEARTBEAT_MS)
  check('fixture: the feed rests at the idle floor behind a live watcher', feed.heartbeatMs() === IDLE_PROJECTION_FLOOR_MS && reads === 0, `heartbeatMs=${feed.heartbeatMs()} reads=${reads}`)
  const twin = join(w.watched, `${NAME}.${process.pid}.tmp`)
  writeFileSync(twin, '{"busy":true}\n')
  renameSync(twin, w.path)
  const t0 = Date.now()
  const soon = await untilAsync(() => reads >= 1, SOON_MS)
  check(`the publish is read within ${SOON_MS} ms of the twin's report (the file's own name never reached the watcher)`, soon, `reads=${reads} after ${Date.now() - t0} ms; the idle floor is ${IDLE_PROJECTION_FLOOR_MS} ms`)
  if (!soon) {
    const eventually = await untilAsync(() => reads >= 1, IDLE_PROJECTION_FLOOR_MS + 2 * HEARTBEAT_MS)
    check('CONTROL: the same publish is read at the idle floor (the heartbeat was its only road)', eventually, `reads=${reads} after ${Date.now() - t0} ms`)
  }
  feed.stop()
  rmSync(resolve(w.watched, '..'), { recursive: true, force: true })
}

section("§2 a twin reported ahead of the file's landing: the feed re-checks within a heartbeat")
{
  const w = world()
  let reads = 0
  const feed = new ProjectionFeed(w.watched, w.path, () => reads++, () => IDLE_PROJECTION_FLOOR_MS)
  feed.start()
  await sleep(2 * HEARTBEAT_MS)
  const twin = join(w.watched, `${NAME}.${process.pid}.tmp`)
  writeFileSync(twin, '{"busy":true}\n')
  await sleep(50)
  check('fixture: the twin alone is no change (the file is still absent)', reads === 0, `reads=${reads}`)
  const staged = join(w.elsewhere, `${NAME}.staged`)
  writeFileSync(staged, '{"busy":true}\n')
  renameSync(staged, w.path)
  const t0 = Date.now()
  const soon = await untilAsync(() => reads >= 1, SOON_MS)
  check(`the file that landed after the twin's report, with no report of its own, is read within ${SOON_MS} ms`, soon, `reads=${reads} after ${Date.now() - t0} ms`)
  if (!soon) {
    const eventually = await untilAsync(() => reads >= 1, IDLE_PROJECTION_FLOOR_MS + 2 * HEARTBEAT_MS)
    check('CONTROL: the landing is read at the idle floor (the heartbeat was its only road)', eventually, `reads=${reads} after ${Date.now() - t0} ms`)
  }
  const before = reads
  await sleep(2 * HEARTBEAT_MS)
  check('quiet after the read: the re-check is one stat, not a second change', reads === before, `reads=${reads} vs ${before}`)
  feed.stop()
  rmSync(resolve(w.watched, '..'), { recursive: true, force: true })
}

section('§3 structural: every report of the directory watch reaches the tick; the file-name filter is gone')
{
  const src = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const feedSrc = src.slice(src.indexOf('export class ProjectionFeed'), src.indexOf('export class DaemonSessionConnector'))
  check('the projection feed no longer keeps a report only when it names the file', !feedSrc.includes('join(this.dir, String(filename)) === this.path'))
  check('a report that found the key unmoved arms one re-check a heartbeat later', /setTimeout\(\(\) => \{[\s\S]*?\}, HEARTBEAT_MS\)/.test(feedSrc))
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-projection-twin-event: ALL LAWS HOLD' : `\nprove-projection-twin-event: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
