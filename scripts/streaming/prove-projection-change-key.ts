#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-projection-change-key.ts — a projection feed
//  detects change by more than mtime: two publishes inside one clock tick
//  read as two (FN-016 R21, [Windows]).
//
//  THE DEFECT: ProjectionFeed's tick compared statSync(path).mtimeMs with
//  the last one and nothing else; the directory watch called the same
//  tick. Windows stamps file times on the system timer tick (~15.6 ms by
//  default), so the tail's text publish and the block-stop clear a few
//  milliseconds behind it could carry the same mtimeMs — the reader saw
//  one change and missed the block boundary: textActive stayed true, the
//  verb row stayed suppressed (REPL) and StreamingHoldRow kept standing
//  with a token count that no longer moved, adding "still waiting" to a
//  stream that had already ended. On win32, where the tail itself does not
//  paint inline, that hold row is the only live signal the operator has.
//
//  THE LAW: the change key is mtime + size + inode (projectionChangeKey).
//  The named pair always differs in size (a text publish strictly grows;
//  the clear shrinks); every publish is a temp-write plus rename, so a
//  fresh inode tells even an equal-size same-tick pair apart wherever the
//  filesystem hands out fresh inodes.
//
//   §1 the pure key: size and inode each break an mtime tie; an identical
//      stat keys identical;
//   §2 THE DEFECT PIN, live: a real feed over a real file — a second
//      publish with the SAME mtime (forced on the temp file before its
//      rename, the writer's own discipline) and a different size fires
//      onChange; the mtime-only control shows the tie the old key
//      collapsed on; a same-size same-mtime republish fires too where the
//      inode moved (reported, not forced: some filesystems reuse inodes);
//   §3 structural: the feed keys on projectionChangeKey; no bare mtime
//      compare remains.
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-projection-change-key.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

const connector = await import(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'))
const { projectionChangeKey, ProjectionFeed } = connector as {
  projectionChangeKey: (stat: { mtimeMs: number; size: number; ino: number }) => string
  ProjectionFeed: new (dir: string, path: string, onChange: () => void) => { start(): void; stop(): void }
}

section('§1 the pure key')
{
  const base = { mtimeMs: 1_700_000_000_000, size: 120, ino: 4242 }
  check('an identical stat keys identical', projectionChangeKey(base) === projectionChangeKey({ ...base }))
  check('the size breaks an mtime tie (the tail\'s text publish then its clear)', projectionChangeKey(base) !== projectionChangeKey({ ...base, size: 12 }))
  check('the inode breaks an mtime+size tie (a fresh file per publish)', projectionChangeKey(base) !== projectionChangeKey({ ...base, ino: 4243 }))
  check('the mtime still counts on its own', projectionChangeKey(base) !== projectionChangeKey({ ...base, mtimeMs: base.mtimeMs + 1 }))
}

section('§2 THE DEFECT PIN, live: two publishes, one mtime, two changes')
{
  const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'projection-feed-'))
  const path = join(dir, 'tail.json')
  let changes = 0
  const feed = new ProjectionFeed(dir, path, () => {
    changes++
  })
  // The writer's own discipline: temp-write, then rename. The mtime is
  // forced on the TEMP file before the rename, so the destination carries
  // it from the moment it appears (a utimes after the rename would be a
  // second change of its own).
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
  check('an absent file is no change', changes === 0)
  // ONE clock tick for every publish of the pair: a whole-second stamp,
  // forced on each temp file before its rename. (A natural first stamp
  // carries the filesystem's sub-millisecond fraction, which a Date built
  // from mtimeMs cannot reproduce — the tie must be forced on both sides.)
  const tie = new Date(Math.floor(Date.now() / 1000) * 1000)
  publish('{"text":"Hello"}\n', tie)
  check('the first publish fires onChange', await waitFor(1), `changes ${changes}`)
  const first = statSync(path)
  // THE PAIR: the clear a few milliseconds behind the text, stamped on the
  // same clock tick — shorter bytes, identical mtime.
  publish('{"text":null}\n', tie)
  const second = statSync(path)
  check('CONTROL (the disease\'s condition): the pair carries ONE mtime on this filesystem', second.mtimeMs === first.mtimeMs, `${first.mtimeMs} vs ${second.mtimeMs}`)
  check('…and the sizes differ (the term that tells the pair apart)', second.size !== first.size, `${first.size} vs ${second.size}`)
  check('THE DEFECT PIN: the same-mtime, different-size publish fires onChange', await waitFor(2), `changes ${changes}`)
  // The equal-size same-tick republish (14 bytes, like the clear): told
  // apart by the inode where the filesystem hands out a fresh one (reported
  // honestly either way).
  publish('{"text":"Hi"}\n', tie)
  const third = statSync(path)
  check('fixture: the third publish is equal-size and same-tick', third.size === second.size && third.mtimeMs === second.mtimeMs, `${second.size}/${second.mtimeMs} vs ${third.size}/${third.mtimeMs}`)
  if (third.ino !== second.ino) {
    check('a same-mtime same-size republish fires onChange (the inode moved with the rename)', await waitFor(3), `changes ${changes}`)
  } else {
    console.log('  [NOTE] this filesystem reused the inode across the rename — the inode term is inert here (not a failure)')
  }
  // Quiet: with no publish the heartbeat fires nothing further.
  const before = changes
  await new Promise(r => setTimeout(r, 900))
  check('no publish, no change (the heartbeat is idempotent per key)', changes === before, `changes ${changes} vs ${before}`)
  feed.stop()
  rmSync(dir, { recursive: true, force: true })
}

section('§3 structural: the feed keys on projectionChangeKey')
{
  const src = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check('the tick derives its key through the one owner', src.includes('key = projectionChangeKey(statSync(this.path))'))
  check('no bare mtime compare remains in the feed', !src.includes('mtime !== this.lastMtime') && !src.includes('this.lastMtime'))
}

console.log(failures === 0 ? '\nprove-projection-change-key: ALL LAWS HOLD' : `\nprove-projection-change-key: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
