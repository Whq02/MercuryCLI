#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { defineStore } from '../../src/substrate/fileStore.ts'

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

const revisionOf = (file: string): number => {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { _rev?: { revision?: number } }
  return raw._rev?.revision ?? 0
}

console.log('============================================================')
console.log(' group commit: batched, complete, ordered, isolated')
console.log('============================================================')

const N = 24

{
  const file = guard(join(SCRATCH, 'batch.json'))
  const store = makeStore(file)
  await store.write({ applied: [] })
  const before = revisionOf(file)

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

{
  const file = guard(join(SCRATCH, 'durable.json'))
  const store = makeStore(file)
  await store.write({ applied: [] })

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
