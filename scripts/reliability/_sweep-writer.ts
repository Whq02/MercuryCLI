#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { resolve } from 'node:path'
import { defineStore } from '../../src/substrate/fileStore.ts'

const file = process.argv[2]
const writerId = process.argv[3]
const k = Number(process.argv[4])
const root = process.env.KEEL_SWEEP_ROOT
if (!file || !writerId || !Number.isInteger(k) || k < 1 || !root) {
  console.error('usage: KEEL_SWEEP_ROOT=<dir> _sweep-writer.ts <store-file> <writer-id> <k>')
  process.exit(2)
}
if (!resolve(file).startsWith(resolve(root))) {
  console.error(`refusing write outside sweep root: ${file}`)
  process.exit(2)
}

const deadline = setTimeout(() => {
  console.error(`writer ${writerId}: deadline exceeded`)
  process.exit(1)
}, 240_000)
deadline.unref?.()

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const barrier = process.env.KEEL_SWEEP_BARRIER
if (!barrier || !resolve(barrier).startsWith(resolve(root))) {
  console.error('KEEL_SWEEP_BARRIER missing or outside the sweep root')
  process.exit(2)
}
writeFileSync(join(barrier, `ready-${writerId}`), '')
while (!existsSync(join(barrier, 'go'))) {
  await new Promise(r => setTimeout(r, 10))
}

interface Doc {
  marks: string[]
}
const store = defineStore<Doc, []>({
  name: 'keel-writer-sweep',
  path: () => file,
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && Array.isArray((raw as { marks?: unknown }).marks)
      ? { marks: (raw as { marks: string[] }).marks }
      : null,
  empty: () => ({ marks: [] }),
  onReadFailure: 'empty',
})()

const results = await Promise.allSettled(
  Array.from({ length: k }, (_, i) =>
    store.mutate(cur => ({ marks: [...cur.marks, `${writerId}:${i}`] })),
  ),
)
const rejected = results.filter(r => r.status === 'rejected')
if (rejected.length > 0) {
  for (const r of rejected) {
    console.error(`writer ${writerId}: DROPPED — ${(r as PromiseRejectedResult).reason}`)
  }
  process.exit(1)
}
console.log(`DONE ${writerId}`)
process.exit(0)
