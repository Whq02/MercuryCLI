#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setEmitReadGateForProofs, defineStore, publishAtomic } from '../../src/substrate/fileStore.ts'
import { uiClockStatsForProofs } from '../../src/utils/cockpit/uiClock.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

type Shape = { n: number; pad?: string }
const FLOOR_MS = 200
const probe = defineStore<Shape, [string]>({
  name: 'statGateProbe',
  schemaVersion: 1,
  path: d => join(d, 'probe.json'),
  onReadFailure: 'empty',
  empty: () => ({ n: 0 }),
  decode: raw =>
    raw !== null && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
      ? { n: (raw as { n: number }).n, ...(typeof (raw as { pad?: unknown }).pad === 'string' ? { pad: (raw as { pad: string }).pad } : {}) }
      : null,
  pollFloorMs: FLOOR_MS,
})

const dir = mkdtempSync(join(tmpdir(), 'filestore-stat-gate-'))
const store = probe(dir)
let reads = 0
_setEmitReadGateForProofs(async () => {
  reads++
})

try {
  await store.write({ n: 1 })
  const seen: number[] = []
  const unsub = store.subscribe(v => seen.push(v.n))
  await sleep(FLOOR_MS * 3)
  const stats0 = store._statsForProofs()
  check('the watcher attached and the floor is armed', stats0.watcher && stats0.pollFloorTimer, JSON.stringify(stats0))

  reads = 0
  await sleep(FLOOR_MS * 4)
  check('§1 floor ticks over an unchanged store read nothing', reads === 0, `reads=${reads}`)
  check('§1 the runtime holds the change key of the bytes it read', typeof store._statsForProofs().lastStatKey === 'string', String(store._statsForProofs().lastStatKey))

  await store.write({ n: 2, pad: 'x'.repeat(2 * 1024 * 1024) })
  await sleep(FLOOR_MS * 3)
  reads = 0
  await sleep(FLOOR_MS * 4)
  check('§1b a 2 MB store at rest reads nothing per floor (the cost never grows with the store)', reads === 0, `reads=${reads}`)
  check('§1b the local publish was delivered', seen.includes(2), JSON.stringify(seen))

  check('§2 the floor is a subscriber of the shared cadence bucket', (uiClockStatsForProofs()[FLOOR_MS] ?? 0) >= 1, JSON.stringify(uiClockStatsForProofs()))

  const keyBefore = store._statsForProofs().lastStatKey
  reads = 0
  const outside = JSON.stringify({ n: 7, _v: 1 }) + '\n'
  await publishAtomic(store.path, outside)
  const t0 = Date.now()
  while (!seen.includes(7) && Date.now() - t0 < FLOOR_MS * 3) await sleep(20)
  check('§3 a rename-over publish from outside the runtime is delivered within one floor', seen.includes(7), `seen=${JSON.stringify(seen)} after ${Date.now() - t0}ms`)
  check('§3 the delivery cost a read (the gate opened)', reads >= 1, `reads=${reads}`)
  await sleep(FLOOR_MS * 2)
  check('§3 the change key moved with the new inode', store._statsForProofs().lastStatKey !== keyBefore && store._statsForProofs().lastStatKey !== null, `${keyBefore} → ${store._statsForProofs().lastStatKey}`)

  await store.write({ n: 9 })
  check('§4 a local publish clears the change key', store._statsForProofs().lastStatKey === null, String(store._statsForProofs().lastStatKey))
  await sleep(FLOOR_MS * 3)
  check('§4 the floor re-latched the key after its read', typeof store._statsForProofs().lastStatKey === 'string')

  unsub()
  await sleep(50)
  check('§2 the last subscriber leaves the bucket', (uiClockStatsForProofs()[FLOOR_MS] ?? 0) === 0, JSON.stringify(uiClockStatsForProofs()))
  check('the floor stopped with the last listener', !store._statsForProofs().pollFloorTimer)
} finally {
  _setEmitReadGateForProofs(null)
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅ FILESTORE STAT GATE: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
