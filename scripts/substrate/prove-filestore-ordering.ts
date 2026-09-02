#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineStore, _setEmitReadGateForProofs } from '../../src/substrate/fileStore.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Ceiling on how long a WATCHER delivery may take before it counts as never
 * having arrived (§4a, §8b). Both loops exit the instant the event lands — 150ms
 * and 50ms respectively on an unloaded machine — so this bound costs nothing
 * when the contract holds. It only decides how much SCHEDULING DELAY is read as
 * a broken contract.
 *
 * It was 3000ms, tuned on a free machine, and that made the full pool red for
 * machine load rather than for the kernel: pool 9 reported
 * `§4a … pre-delete after 3000ms` while the same prover passed solo in 150ms.
 * Under a 129-suite pool the FSEvents debounce and chokidar's 100ms
 * atomic-coalescing hold queue behind seconds of other work, and the Linux arm
 * waits on a 1000ms poll FLOOR that can slip several intervals.
 *
 * That matters MORE here than in a pty suite, not less. run-all-suites.sh
 * re-runs a failed suite solo exactly once — but ONLY for pty/undeclared
 * classes. `substrate` is declared `gate-class: cpu`, so its RED is taken as
 * genuine and never retried. A wall-clock timing dependency in a cpu-class
 * suite therefore has no safety net at all, which is the real defect this
 * bound was expressing.
 *
 * The assertion is unchanged — a delivery that never happens still fails, and
 * the observed `waited` is reported either way, so a real latency regression
 * stays visible in the detail rather than being hidden by the larger bound.
 */
const WATCHER_DELIVERY_BUDGET_MS = 15_000

type Doc = { n: number; tag: string }
const dir = mkdtempSync(join(tmpdir(), 'fs-order-'))
process.env.MERCURY_CONFIG_DIR = dir
const filePath = join(dir, 'doc.json')

const store = defineStore<Doc>({
  name: 'order-proof',
  path: () => filePath,
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && typeof (raw as Doc).n === 'number'
      ? { n: (raw as Doc).n, tag: String((raw as Doc).tag ?? '') }
      : null,
  empty: () => ({ n: -1, tag: 'empty' }),
  onReadFailure: 'empty',
})()

console.log('prove-filestore-ordering')

{
  const got: Array<{ n: number; at: number }> = []
  const unsub = store.subscribe(v => got.push({ n: v.n, at: performance.now() }), { immediate: false })
  await store.write({ n: 1, tag: 'one' })
  const tResolved = performance.now()
  check(
    '§1 in-process publish delivered BEFORE write() resolved (microtask, not the 25ms debounce)',
    got.length === 1 && got[0]!.at <= tResolved,
    got.length ? `delivered ${(tResolved - got[0]!.at).toFixed(1)}ms before resolution` : 'no delivery',
  )
  await sleep(250)
  check('§2 watcher echo of own publish deduped (exactly one delivery)', got.filter(g => g.n === 1).length === 1, `${got.length} deliveries`)
  unsub()
}

{
  let violation = ''
  for (let i = 0; i < 20 && !violation; i++) {
    const seen: number[] = []
    const unsub = store.subscribe(v => seen.push(v.n), { immediate: true })
    await store.write({ n: 100 + i, tag: `iter${i}` })
    await sleep(30)
    const last = seen[seen.length - 1]
    if (last !== 100 + i) violation = `iter ${i}: last delivery n=${last}, expected ${100 + i} (stale initial read delivered after the publish)`
    for (let k = 1; k < seen.length; k++) {
      if (seen[k]! < seen[k - 1]!) violation = `iter ${i}: delivery order regressed ${seen[k - 1]} → ${seen[k]}`
    }
    unsub()
  }
  check('§3 never-old-after-new across 20 subscribe/write interleavings', violation === '', violation)
}

{
  const seen: string[] = []
  const unsub = store.subscribe(v => seen.push(v.tag), { immediate: false })
  await store.write({ n: 6, tag: 'pre-delete' })
  await sleep(150)
  unlinkSync(filePath)
  let waited = 0
  while (!seen.includes('empty') && waited < WATCHER_DELIVERY_BUDGET_MS) {
    await sleep(50)
    waited += 50
  }
  check('§4a delete emits the declared empty()', seen.includes('empty'), `${seen.join(',')} after ${waited}ms`)
  await store.write({ n: 7, tag: 'reborn' })
  await sleep(50)
  check('§4b recreate emits the new value', seen[seen.length - 1] === 'reborn', seen.join(','))
  unsub()
}

{
  const seen: string[] = []
  const unsub = store.subscribe(v => seen.push(v.tag), { immediate: false })
  const tmp = join(dir, '.corrupt.tmp')
  writeFileSync(tmp, '{ this is not json')
  renameSync(tmp, filePath)
  await sleep(300)
  check('§5a corrupt intermediate emits nothing (skipped, logged)', seen.length === 0, seen.join(','))
  await store.write({ n: 9, tag: 'healed' })
  await sleep(50)
  check('§5b next valid publish recovers the stream', seen[seen.length - 1] === 'healed', seen.join(','))
  unsub()
}

{
  const a: number[] = []
  const b: number[] = []
  const unsubA = store.subscribe(v => a.push(v.n), { immediate: false })
  const unsubB = store.subscribe(v => b.push(v.n), { immediate: false })
  await store.write({ n: 20, tag: 'both' })
  await sleep(20)
  check('§6a both subscribers received', a.includes(20) && b.includes(20))
  unsubA()
  await store.write({ n: 21, tag: 'only-b' })
  await sleep(20)
  check('§6b after unsubscribe A, only B receives', !a.includes(21) && b.includes(21))
  unsubB()
}

{
  await sleep(50)
  const stats = store._statsForProofs()
  check(
    '§7 zero live watchers/timers after last unsubscribe',
    stats.listeners === 0 && !stats.watcher && !stats.pollTimer && !stats.pollFloorTimer && !stats.debounceTimer,
    JSON.stringify(stats),
  )
}

{
  const seen: string[] = []
  const unsub = store.subscribe(v => seen.push(v.tag), { immediate: false })
  await sleep(100)
  const child = `
    const { writeFileSync, renameSync } = require('node:fs');
    const tmp = ${JSON.stringify(filePath)} + '.child.tmp';
    writeFileSync(tmp, JSON.stringify({ n: 42, tag: 'from-child', _v: 1 }));
    renameSync(tmp, ${JSON.stringify(filePath)});
  `
  const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' })
  check('§8a child writer exited clean', r.status === 0, r.stderr ?? '')
  let waited = 0
  while (!seen.includes('from-child') && waited < WATCHER_DELIVERY_BUDGET_MS) {
    await sleep(50)
    waited += 50
  }
  check('§8b cross-process write delivered via watcher', seen.includes('from-child'), `${waited}ms`)
  unsub()
}

{
  const file9 = join(dir, 'doc9.json')
  const store9 = defineStore<Doc>({
    name: 'fence-proof',
    path: () => file9,
    schemaVersion: 1,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as Doc).n === 'number'
        ? { n: (raw as Doc).n, tag: String((raw as Doc).tag ?? '') }
        : null,
    empty: () => ({ n: -1, tag: 'empty' }),
    onReadFailure: 'empty',
    pollFloorMs: 300,
  })()
  const seen: number[] = []
  const unsub = store9.subscribe(v => seen.push(v.n), { immediate: false })
  await store9.write({ n: 1, tag: 'base' })
  await sleep(250)

  let releaseGate!: () => void
  const gate = new Promise<void>(r => {
    releaseGate = r
  })
  let gated = 0
  _setEmitReadGateForProofs(() => {
    gated++
    return gate
  })

  const tmp9 = `${file9}.ext.tmp`
  writeFileSync(tmp9, JSON.stringify({ n: 2, tag: 'external', _v: 1 }))
  renameSync(tmp9, file9)
  let waited9 = 0
  while (gated === 0 && waited9 < WATCHER_DELIVERY_BUDGET_MS) {
    await sleep(25)
    waited9 += 25
  }
  check('§9a the watcher-path read parked at the injection gate', gated >= 1, `${waited9}ms`)

  await store9.write({ n: 3, tag: 'newest' })
  await sleep(30)
  check('§9b the local publish fanned out immediately', seen[seen.length - 1] === 3, seen.join(','))

  releaseGate()
  _setEmitReadGateForProofs(null)
  await sleep(250)
  const idx3 = seen.indexOf(3)
  check(
    '§9c EPOCH FENCE: the stale read is discarded — never old-after-new',
    idx3 !== -1 && !seen.slice(idx3).includes(2),
    seen.join(','),
  )

  await sleep(1000)
  check(
    '§9d newest stays last through 3+ no-write floor intervals (no sticky-stale swallow)',
    seen[seen.length - 1] === 3,
    seen.join(','),
  )
  check(
    '§9e exactly one emission of the newest value (no stale-then-repeat duplicate)',
    seen.filter(n => n === 3).length === 1,
    seen.join(','),
  )
  unsub()
}

{
  const stats = store._statsForProofs()
  check(
    '§10 last unsubscribe resets the revision/opId watermark (fresh re-subscribe baseline)',
    stats.lastSeenRevision === null && stats.lastEmittedOpId === null,
    JSON.stringify(stats),
  )
}

{
  const file11 = join(dir, 'doc11.json')
  const store11 = defineStore<Doc>({
    name: 'authority-proof',
    path: () => file11,
    schemaVersion: 1,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as Doc).n === 'number'
        ? { n: (raw as Doc).n, tag: String((raw as Doc).tag ?? '') }
        : null,
    empty: () => ({ n: -1, tag: 'empty' }),
    onReadFailure: 'empty',
    pollFloorMs: 300,
  })()
  const changes: Array<{ n: number; cause: string; skipped: number }> = []
  const unsub = store11.subscribeChanges(
    c => changes.push({ n: c.value.n, cause: c.cause, skipped: c.skippedRevisions }),
    { immediate: false },
  )
  await store11.write({ n: 1, tag: 'r1' })
  await store11.write({ n: 2, tag: 'r2' })
  await store11.write({ n: 3, tag: 'r3' })
  await sleep(250)

  const externalWrite = (n: number, revision: number, op: string): void => {
    const tmp = `${file11}.ext.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({
        n,
        tag: `ext-${revision}`,
        _v: 1,
        _rev: { revision, writerId: 'pid:999', operationId: op, committedAt: '', digest: '' },
      }),
    )
    renameSync(tmp, file11)
  }

  externalWrite(10, 1, 'ext-op-reset')
  let waitedA = 0
  while (!changes.some(c => c.n === 10) && waitedA < WATCHER_DELIVERY_BUDGET_MS) {
    await sleep(50)
    waitedA += 50
  }
  check(
    '§11a a backward stamped revision still DELIVERS (content authority — never deaf)',
    changes.some(c => c.n === 10),
    `${waitedA}ms ${JSON.stringify(changes)}`,
  )

  externalWrite(11, 3, 'ext-op-jump')
  let waitedB = 0
  while (!changes.some(c => c.n === 11) && waitedB < WATCHER_DELIVERY_BUDGET_MS) {
    await sleep(50)
    waitedB += 50
  }
  const jump = changes.find(c => c.n === 11)
  check(
    '§11b the adopted watermark makes the next skip PROVABLE (rev1→rev3 = 1 skipped, catch-up)',
    jump !== undefined && jump.skipped === 1 && jump.cause === 'catch-up',
    JSON.stringify(changes),
  )
  unsub()
}

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ prove-filestore-ordering: all green' : `\n✗ prove-filestore-ordering: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
