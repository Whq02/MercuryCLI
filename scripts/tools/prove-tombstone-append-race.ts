#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-tombstone-append-race.ts
//  PROOF for: Project.removeMessageByUuid stat()s the session file size
//  then truncate(absLineStart)+write WITHOUT serializing against the 100ms
//  batched append-drain. A drain (appendToFile @ EOF) firing in the
//  stat()->truncate() window makes the truncate (computed from the STALE
//  pre-append size) discard the just-appended bytes (loss-mode A, orphan last)
//  or re-blit the old tail over them (loss-mode B, orphan mid-file). The fix is
//  an in-memory serializer (fileWriteChain) that BOTH the append-drain and the
//  tombstone route through, AND a drain-before-truncate inside the held chain.
//
//  sessionStorage.ts imports `feature` from bun:bundle + the gate module (BLOCKS_ON_
//  INIT) so it is bun-unloadable for a direct behavioral test (same as its
//  sibling prove-lite-metadata-sidechain.ts). So this proves the fix two ways:
//   (1) SOURCE-TEXT: the real file wires serializeWrite/_drainWriteQueueInner/
//       fileWriteChain and removeMessageByUuid drains-before-truncate (never
//       flush()).
//   (2) BEHAVIOURAL MIRROR: a verbatim transcription of the real fast-path
//       algorithm + the real serializer, run with the serializer ON vs OFF,
//       injecting a concurrent append into the stat->truncate window. OFF
//       loses/corrupts data; ON preserves it across many timing-jittered runs
//       and does not deadlock.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-tombstone-append-race.ts
// ============================================================================
import {
  readFileSync,
  appendFileSync,
  openSync,
  fstatSync,
  readSync,
  ftruncateSync,
  writeSync,
  closeSync, readdirSync } from 'node:fs'
import {
  open as fsOpen,
  appendFile as fsAppendFile,
  readFile,
  writeFile,
  mkdtemp,
  rm,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// R5 module-scoped read: the Project writer moved to the owned
// sessionStorage/ submodules; these invariants are module-scoped.
const storage = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage.ts'),
  'utf-8',
) + readdirSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage')).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage', f), 'utf-8')).join('\n')

console.log('============================================================')
console.log(' tombstone vs append-drain race — serialized (HB-0113)')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('source: the real serializer + drain-before-truncate are wired')
check(
  'a private fileWriteChain field exists',
  /private fileWriteChain: Promise<unknown> = Promise\.resolve\(\)/.test(storage),
)
check(
  'serializeWrite chains via dual-branch .then(fn, fn) so a rejection cannot starve it',
  /serializeWrite<T>\([\s\S]{0,200}this\.fileWriteChain\.then\(\s*\(\) => fn\(\),\s*\(\) => fn\(\),?\s*\)/.test(
    storage,
  ),
)
check(
  'the stored chain tail swallows rejections (.catch) so it cannot latch',
  /this\.fileWriteChain = run\.catch\(\(\) => \{\}\)/.test(storage),
)
check(
  'drainWriteQueue routes the disk work through serializeWrite(_drainWriteQueueInner)',
  /private drainWriteQueue\(\): Promise<void> \{/.test(storage) &&
    /return this\.serializeWrite\(\(\) => this\._drainWriteQueueInner\(\)\)/.test(storage),
)
check(
  'the real drain body moved to _drainWriteQueueInner (still splices the queue + appendToFile)',
  // (the body grew a re-queue-on-failure note ahead of the splice; the window
  // covers the whole preamble)
  /private async _drainWriteQueueInner\(\): Promise<void> \{[\s\S]{0,1400}queue\.splice\(0\)/.test(
    storage,
  ),
)
// removeMessageByUuid: serialized + drain-before-truncate, NOT flush()
const removeBody = storage.slice(
  storage.indexOf('async removeMessageByUuid'),
  storage.indexOf('async removeMessageByUuid') + 4400,
)
check(
  'removeMessageByUuid routes the mutation through serializeWrite',
  /trackWrite\(\(\) =>\s*this\.serializeWrite\(async \(\) => \{/.test(removeBody),
)
check(
  'removeMessageByUuid drains the queue (inner) BEFORE the truncate',
  removeBody.indexOf('await this._drainWriteQueueInner()') >= 0 &&
    removeBody.indexOf('await this._drainWriteQueueInner()') <
      removeBody.indexOf('ftruncateSync(fd'),
)
check(
  'removeMessageByUuid does NOT call this.flush() (would self-deadlock under trackWrite)',
  !/this\.flush\(\)/.test(removeBody),
)
check(
  '_resetFlushState resets the chain so test resets do not leak a pending write',
  /_resetFlushState\(\): void \{[\s\S]{0,300}this\.fileWriteChain = Promise\.resolve\(\)/.test(
    storage,
  ),
)
// The serializer only coordinates ASYNC writers. The synchronous
// appendEntryToFile metadata path (saveCustomTitle/tagSession/saveAgentName/
// reAppendSessionMetadata, via getFsImplementation().appendFileSync) bypasses
// the queue+chain — so removeMessageByUuid's read->truncate must be a SYNC
// block to be atomic against it (a sync block cannot be interleaved by
// appendFileSync on the same JS thread). Assert the I/O is synchronous.
check(
  'removeMessageByUuid opens the file synchronously (openSync, not async fsOpen)',
  /openSync\(this\.sessionFile, 'r\+'\)/.test(removeBody) && !/await fsOpen\(this\.sessionFile/.test(removeBody),
)
check(
  'the fast-path mutation is synchronous (ftruncateSync + writeSync, no async fh.truncate/fh.write)',
  /ftruncateSync\(fd, absLineStart\)/.test(removeBody) &&
    /writeSync\(fd, tail, lineEnd, afterLen, absLineStart\)/.test(removeBody) &&
    !/await fh\.truncate|await fh\.write/.test(removeBody),
)
check(
  'the slow-path rewrite is synchronous too (readFileSync + writeFileSync)',
  /readFileSync\(this\.sessionFile/.test(removeBody) && /writeFileSync\(this\.sessionFile/.test(removeBody),
)

// ───────────────────────────────────────────────────────────────────────────
section('behavioural mirror: verbatim fast-path algorithm, serializer ON vs OFF')

const LITE_READ_BUF_SIZE = 64 * 1024
const enc = (o: unknown) => JSON.stringify(o)

// A faithful, minimal transcription of the real Project write machinery.
class MirrorProject {
  private queue: string[] = []
  private fileWriteChain: Promise<unknown> = Promise.resolve()
  constructor(
    private file: string,
    private useSerializer: boolean,
  ) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.useSerializer) return fn()
    const run = this.fileWriteChain.then(
      () => fn(),
      () => fn(),
    )
    this.fileWriteChain = run.catch(() => {})
    return run
  }

  private async drainInner(): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0)
    await fsAppendFile(this.file, batch.join(''), { mode: 0o600 })
  }

  // public drain — serialized in the fixed variant (matches real drainWriteQueue)
  drain(): Promise<void> {
    return this.serialize(() => this.drainInner())
  }

  enqueue(entry: unknown): void {
    this.queue.push(enc(entry) + '\n')
  }

  // Models the SYNCHRONOUS appendEntryToFile metadata path (appendFileSync) —
  // it bypasses the queue and the chain entirely, same as the real code.
  syncAppend(entry: unknown): void {
    appendFileSync(this.file, enc(entry) + '\n', { mode: 0o600 })
  }

  // Verbatim sync transcription of the REAL fixed fast path: stat->read->
  // truncate->write with NO await between, so it is atomic against any
  // appendFileSync on the same JS thread.
  removeSyncBlock(uuid: string): void {
    const fd = openSync(this.file, 'r+')
    try {
      const { size } = fstatSync(fd)
      if (size === 0) return
      const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
      const tailStart = size - chunkLen
      const buf = Buffer.allocUnsafe(chunkLen)
      const bytesRead = readSync(fd, buf, 0, chunkLen, tailStart)
      const tail = buf.subarray(0, bytesRead)
      const needle = `"uuid":"${uuid}"`
      const matchIdx = tail.lastIndexOf(needle)
      if (matchIdx >= 0) {
        const prevNl = tail.lastIndexOf(0x0a, matchIdx)
        if (prevNl >= 0 || tailStart === 0) {
          const lineStart = prevNl + 1
          const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
          const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead
          const absLineStart = tailStart + lineStart
          const afterLen = bytesRead - lineEnd
          ftruncateSync(fd, absLineStart)
          if (afterLen > 0) writeSync(fd, tail, lineEnd, afterLen, absLineStart)
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  // verbatim transcription of removeMessageByUuid's fast path, with a window
  // hook injected at the exact stat->read->truncate boundary the bug lives in.
  removeMessageByUuid(uuid: string, windowHook?: () => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      // drain-before-truncate is the FIXED behaviour only (real code calls
      // _drainWriteQueueInner here unconditionally; the OFF variant models the
      // pre-fix code which had no such drain and no serializer).
      if (this.useSerializer) await this.drainInner()
      const fh = await fsOpen(this.file, 'r+')
      try {
        const { size } = await fh.stat()
        if (size === 0) return
        // INJECTION: a concurrent append-drain firing in the window. In the
        // OFF variant this writes to disk now (size is already stale); in the
        // ON variant the same drain is queued behind the held chain.
        if (windowHook) await windowHook()
        const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
        const tailStart = size - chunkLen
        const buf = Buffer.allocUnsafe(chunkLen)
        const { bytesRead } = await fh.read(buf, 0, chunkLen, tailStart)
        const tail = buf.subarray(0, bytesRead)
        const needle = `"uuid":"${uuid}"`
        const matchIdx = tail.lastIndexOf(needle)
        if (matchIdx >= 0) {
          const prevNl = tail.lastIndexOf(0x0a, matchIdx)
          if (prevNl >= 0 || tailStart === 0) {
            const lineStart = prevNl + 1
            const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
            const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead
            const absLineStart = tailStart + lineStart
            const afterLen = bytesRead - lineEnd
            await fh.truncate(absLineStart)
            if (afterLen > 0) {
              await fh.write(tail, lineEnd, afterLen, absLineStart)
            }
            return
          }
        }
      } finally {
        await fh.close()
      }
    })
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Run one race: seed entries, fire a tombstone of `orphanUuid`, and — inside
// the stat->truncate window — let a fresh append (U-FRESH) drain. Returns the
// surviving uuids on disk.
async function runRace(opts: {
  useSerializer: boolean
  orphanLast: boolean
}): Promise<{ uuids: string[]; timedOut: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'hb0113-'))
  const file = join(dir, 'session.jsonl')
  try {
    // Seed. orphanLast=true → ORPHAN is the final line (afterLen==0, loss-mode
    // A). orphanLast=false → a TRAIL entry sits after ORPHAN (afterLen>0,
    // loss-mode B re-blit corruption).
    const seed = opts.orphanLast
      ? [{ uuid: 'U1' }, { uuid: 'ORPHAN' }]
      : [{ uuid: 'U1' }, { uuid: 'ORPHAN' }, { uuid: 'TRAIL' }]
    await writeFile(file, seed.map(e => enc(e) + '\n').join(''), { mode: 0o600 })

    const p = new MirrorProject(file, opts.useSerializer)
    // A fresh user message arrives concurrently (the real REPL callback does
    // not flush first). Queue it, then fire its drain inside the window.
    p.enqueue({ uuid: 'FRESH' })
    const windowHook = async () => {
      // model the 100ms-batched drain firing now. Do NOT await it (the real
      // drain is a detached task); just kick it and yield long enough for its
      // fsAppendFile to land if it is going to.
      void p.drain()
      await delay(25)
    }
    const removeP = p.removeMessageByUuid('ORPHAN', windowHook)
    // settle + final flush of anything still queued behind the chain
    let timedOut = false
    await Promise.race([
      (async () => {
        await removeP
        await p.drain()
      })(),
      delay(2000).then(() => {
        timedOut = true
      }),
    ])

    const content = await readFile(file, 'utf-8')
    const uuids = content
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l).uuid as string
        } catch {
          return '<corrupt>'
        }
      })
    return { uuids, timedOut }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── OFF (pre-fix): the race must lose or corrupt data at least sometimes ──
async function demoLossOff(): Promise<void> {
  let lostA = 0
  let badB = 0
  const N = 30
  for (let i = 0; i < N; i++) {
    const a = await runRace({ useSerializer: false, orphanLast: true })
    if (!a.uuids.includes('FRESH')) lostA++
    const b = await runRace({ useSerializer: false, orphanLast: false })
    // loss-mode B: corruption or a missing/duplicated entry
    if (b.uuids.includes('<corrupt>') || !b.uuids.includes('FRESH') || !b.uuids.includes('TRAIL'))
      badB++
  }
  check(
    `OFF/loss-mode A (orphan last): the fresh append is truncated away in the window (${lostA}/${N} runs)`,
    lostA > 0,
    lostA === 0 ? 'race never triggered — proof would be vacuous' : '',
  )
  check(
    `OFF/loss-mode B (orphan mid-file): corruption / lost trailing line (${badB}/${N} runs)`,
    badB > 0,
    badB === 0 ? 'race never triggered — proof would be vacuous' : '',
  )
}

// ── ON (fixed): every run must keep FRESH (+ TRAIL) and remove ORPHAN, never deadlock ──
async function demoSafeOn(): Promise<void> {
  const N = 50
  let okA = 0
  let okB = 0
  let deadlocks = 0
  for (let i = 0; i < N; i++) {
    const a = await runRace({ useSerializer: true, orphanLast: true })
    if (a.timedOut) deadlocks++
    if (a.uuids.includes('FRESH') && !a.uuids.includes('ORPHAN') && a.uuids.includes('U1')) okA++
    const b = await runRace({ useSerializer: true, orphanLast: false })
    if (b.timedOut) deadlocks++
    if (
      b.uuids.includes('FRESH') &&
      b.uuids.includes('TRAIL') &&
      !b.uuids.includes('ORPHAN') &&
      !b.uuids.includes('<corrupt>')
    )
      okB++
  }
  check(`ON: never deadlocks (flush returns) across ${2 * N} runs`, deadlocks === 0,
    deadlocks ? `${deadlocks} runs exceeded the 2s budget` : '')
  check(`ON/loss-mode A: orphan removed AND fresh+U1 preserved, all ${N} runs`, okA === N,
    okA === N ? '' : `${okA}/${N}`)
  check(`ON/loss-mode B: orphan removed AND fresh+trail preserved, all ${N} runs`, okB === N,
    okB === N ? '' : `${okB}/${N}`)
}

// ── SYNC-APPEND racer: the appendEntryToFile metadata path (refute finding) ──
// The serializer alone does NOT close this — only the SYNCHRONOUS read->truncate
// block does. Prove (1) an async-block tombstone loses a sync append in its
// window, and (2) the real sync-block tombstone never does (either order).
async function withFile<T>(
  seed: string[],
  fn: (file: string, p: MirrorProject) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hb0113s-'))
  const file = join(dir, 'session.jsonl')
  try {
    await writeFile(file, seed.map(u => enc({ uuid: u }) + '\n').join(''), { mode: 0o600 })
    return await fn(file, new MirrorProject(file, true))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const uuidsOf = (file: string): string[] =>
  readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l).uuid as string
      } catch {
        return '<corrupt>'
      }
    })

async function demoSyncAppendRace(): Promise<void> {
  const N = 30
  // (1) async-block tombstone + a sync metadata append injected in the window
  let asyncLost = 0
  for (let i = 0; i < N; i++) {
    const u = await withFile(['U1', 'ORPHAN'], async (file, p) => {
      await p.removeMessageByUuid('ORPHAN', async () => {
        p.syncAppend({ uuid: 'META' }) // appendFileSync lands between stat & truncate
      })
      return uuidsOf(file)
    })
    if (!u.includes('META')) asyncLost++
  }
  check(
    `an ASYNC-block tombstone LOSES a sync metadata append in its window (${asyncLost}/${N}) — why a SYNC block is required`,
    asyncLost > 0,
    asyncLost === 0 ? 'race never triggered — proof would be vacuous' : '',
  )
  // (2) the REAL sync-block tombstone: a sync append serializes around the
  // atomic block — preserved whether it lands before OR after.
  let okBefore = 0
  let okAfter = 0
  for (let i = 0; i < N; i++) {
    const ub = await withFile(['U1', 'ORPHAN'], (file, p) => {
      p.syncAppend({ uuid: 'META' }) // before the block
      p.removeSyncBlock('ORPHAN')
      return uuidsOf(file)
    })
    if (ub.includes('META') && !ub.includes('ORPHAN') && ub.includes('U1')) okBefore++
    const ua = await withFile(['U1', 'ORPHAN'], async (file, p) => {
      // a 0ms timer can only run once the atomic sync block returns
      const t = delay(0).then(() => p.syncAppend({ uuid: 'META' }))
      p.removeSyncBlock('ORPHAN')
      await t
      return uuidsOf(file)
    })
    if (ua.includes('META') && !ua.includes('ORPHAN') && ua.includes('U1')) okAfter++
  }
  check(`SYNC-block tombstone preserves a sync append landing BEFORE, all ${N} runs`, okBefore === N,
    okBefore === N ? '' : `${okBefore}/${N}`)
  check(`SYNC-block tombstone preserves a sync append landing AFTER (atomic block), all ${N} runs`, okAfter === N,
    okAfter === N ? '' : `${okAfter}/${N}`)
}

await demoLossOff()
await demoSafeOn()
await demoSyncAppendRace()

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0113 — tombstone/append-drain race serialized + proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0113 — ${failures} check(s) failed`)
  process.exit(1)
}
