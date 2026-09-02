#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-group-commit.ts — group-commit contract.
//
//  What the code DID: every store mutation ran its own full critical section —
//  lock → read → apply → publish → release — serialized on the per-path
//  opChain. N queued mutations therefore paid N lock acquisitions, N reads and
//  N whole-store republishes.
//
//  Which invariant that MISSED: bounded lock pressure. The lock is held for a
//  fixed cost per MUTATION rather than per BUSY PERIOD, so concurrent writers
//  convoy on it. Measured on the real lock options, 40 concurrent writers
//  exhausted proper-lockfile's ~2.6s retry budget and DROPPED 29 of 600
//  commits outright, with p99 at 2.5s (scripts/engine-durability/bench-authority.ts).
//  The status quo is not
//  merely slow under contention — it loses committed work.
//
//  The fix batches: everything queued while a section is busy is applied in the
//  NEXT one, against a single read, behind a single publish. These laws pin the
//  properties that must survive the batching — the ones that would make a
//  faster store a lying one:
//
//    1. BATCHED   — N concurrent mutations publish FEWER than N times.
//    2. COMPLETE  — every mutation still lands; batching loses nothing.
//    3. ORDERED   — each mutation sees its predecessor's value.
//    4. ISOLATED  — one mutation throwing does not drop its batch-mates.
//    5. DURABLE   — a caller's promise settles only AFTER the bytes are on
//                   disk, never at apply time.
//    6. IDS       — the task-LIST lock guards a DIRECTORY, not a value, so the
//                   batched value there is the ID COUNTER: concurrent creates
//                   claim one contiguous range under one lock and one scan.
//
//  Law 1 exits 1 at the pre-fix tree (revisions == mutations there).
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { defineStore } from '../../src/substrate/fileStore.ts'

// Scratch-explicit: bun's homedir() ignores env HOME, and a prover that
// resolved a "user-local" path implicitly once clobbered a deployed launcher.
const SCRATCH = mkdtempSync(join(tmpdir(), 'keel-groupcommit-'))
const guard = (p: string): string => {
  const abs = resolve(p)
  if (!abs.startsWith(resolve(SCRATCH))) throw new Error(`refusing write outside scratch: ${abs}`)
  return abs
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

interface Doc {
  applied: number[]
}
const makeStore = (file: string) =>
  defineStore<Doc, []>({
    name: 'keel-group-commit',
    path: () => file,
    schemaVersion: 1,
    decode: raw =>
      raw && typeof raw === 'object' && Array.isArray((raw as { applied?: unknown }).applied)
        ? { applied: (raw as { applied: number[] }).applied }
        : null,
    empty: () => ({ applied: [] }),
    onReadFailure: 'empty',
  })()

/** The in-band `_rev` counter advances once per PUBLISH — the observable that
 *  distinguishes one batched commit from N separate ones. */
const revisionOf = (file: string): number => {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { _rev?: { revision?: number } }
  return raw._rev?.revision ?? 0
}

console.log('============================================================')
console.log(' group commit: batched, complete, ordered, isolated')
console.log('============================================================')

const N = 24

// ── laws 1-3 ────────────────────────────────────────────────────────────────
{
  const file = guard(join(SCRATCH, 'batch.json'))
  const store = makeStore(file)
  await store.write({ applied: [] })
  const before = revisionOf(file)

  // Fire them together so they queue behind ONE busy period — the situation the
  // batch exists for. Each appends its own id, so the final array proves both
  // completeness and the order they were applied in.
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.mutate(cur => ({ applied: [...cur.applied, i] })),
    ),
  )

  const after = revisionOf(file)
  const publishes = after - before
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Doc

  check(
    `1. BATCHED: ${N} concurrent mutations published ${publishes}x (< ${N})`,
    publishes < N && publishes >= 1,
    `${publishes} publishes`,
  )
  check(
    `2. COMPLETE: every mutation landed (${doc.applied.length}/${N})`,
    doc.applied.length === N && new Set(doc.applied).size === N,
    `got ${doc.applied.length}`,
  )
  check(
    '3. ORDERED: each mutation saw its predecessor (strictly ascending)',
    doc.applied.every((v, i) => i === 0 || v > doc.applied[i - 1]!),
    JSON.stringify(doc.applied.slice(0, 8)),
  )
}

// ── law 4 ───────────────────────────────────────────────────────────────────
{
  const file = guard(join(SCRATCH, 'isolate.json'))
  const store = makeStore(file)
  await store.write({ applied: [] })

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      store.mutate(cur => {
        if (i === 3) throw new Error('deliberate mutation failure')
        return { applied: [...cur.applied, i] }
      }),
    ),
  )
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Doc
  const rejected = results.filter(r => r.status === 'rejected').length

  check(
    '4. ISOLATED: exactly the failing mutation rejected (1 of 6)',
    rejected === 1,
    `${rejected} rejected`,
  )
  check(
    "4b. ISOLATED: its batch-mates still committed (5 landed, without the thrower's id)",
    doc.applied.length === 5 && !doc.applied.includes(3),
    JSON.stringify(doc.applied),
  )
}

// ── law 5 ───────────────────────────────────────────────────────────────────
{
  const file = guard(join(SCRATCH, 'durable.json'))
  const store = makeStore(file)
  await store.write({ applied: [] })

  // Resolution must imply durability: when the caller's promise settles, the
  // bytes must ALREADY be on disk. Reading the file the instant each promise
  // resolves is the direct observation of that ordering.
  let seenOnDiskAtResolve = 0
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.mutate(cur => ({ applied: [...cur.applied, i] })).then(() => {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as Doc
        if (doc.applied.includes(i)) seenOnDiskAtResolve++
      }),
    ),
  )
  check(
    '5. DURABLE: every caller found its own write on disk at resolve time (8/8)',
    seenOnDiskAtResolve === 8,
    `${seenOnDiskAtResolve}/8`,
  )
}

// ── law 6: batched id allocation (the task-LIST lock) ───────────────────────
// The contended task lock guards a DIRECTORY, not a value, so group commit could
// not be applied to it directly. The batched value is the ID COUNTER: concurrent
// creates must claim a contiguous range under ONE lock acquisition and ONE
// directory scan, with ids still unique.
{
  process.env.MERCURY_CONFIG_DIR = guard(join(SCRATCH, 'cfg'))
  const tasks = await import('../../src/utils/tasks.ts')
  const list = 'keel-group-commit'
  const N = 16
  const ids = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      tasks.createTask(list, {
        subject: `t${i}`,
        description: 'd',
        status: 'pending',
      } as never),
    ),
  )
  const uniq = new Set(ids)
  const nums = ids.map(Number).sort((a, b) => a - b)
  check(
    `6. IDS UNIQUE: ${N} concurrent creates produced ${uniq.size} distinct ids`,
    uniq.size === N,
    ids.join(','),
  )
  check(
    '6b. IDS CONTIGUOUS: the batch claimed one unbroken range',
    nums.every((v, i) => i === 0 || v === nums[i - 1]! + 1),
    nums.join(','),
  )
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} group-commit law(s) failed`)
  process.exit(1)
}
console.log('✅ GROUP COMMIT HOLDS')
