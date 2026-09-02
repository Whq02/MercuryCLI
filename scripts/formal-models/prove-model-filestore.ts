#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/prove-model-filestore.ts — (R2): the
//  fileStore kernel (publication · lane group-commit · corruption recovery)
//  under GENERATED operation sequences, against a reference model.
//
//    §1 generated mutate/read sequences: the lane serializes submissions
//       FIFO, so the durable value always equals the model's sequential
//       application; reads never see a torn or stale-beyond-lane value.
//    §2 scheduler-driven CONCURRENT mutates: every explored interleaving of
//       concurrent submitters still yields exactly the submitted multiset,
//       serialized by the lane (no lost update, no duplication).
//    §3 a GENERATED corruption point (garbage bytes published over the
//       store): the next mutation quarantines the damaged copy (FC5),
//       resumes from the runtime's last-good witness, and the ledger
//       records it — failures retain information.
//
//  Fixed seed; failures print fast-check's seed + path + shrunk sequence.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import fc from 'fast-check'
import { checker, scratchRoot, guardWrite } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-model-filestore')
const t = checker()
const SEED = 20260807

const { defineStore } = await import('../../src/substrate/fileStore.ts')

let storeSerial = 0
interface Box {
  items: number[]
}
function freshStore(): { store: ReturnType<typeof defineStore<Box>>; path: string } {
  const name = `model-box-${++storeSerial}`
  const path = join(root, 'stores', `${name}.json`)
  const store = defineStore<Box>({
    name,
    path: () => path,
    schemaVersion: 1,
    decode: raw => {
      if (!raw || typeof raw !== 'object') return null
      const items = (raw as { items?: unknown }).items
      return Array.isArray(items) ? { items: items as number[] } : null
    },
    empty: () => ({ items: [] }),
    onReadFailure: 'empty',
  })
  return { store, path }
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — generated mutate/read sequences match the reference model')
{
  let failure = ''
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 999 }), { maxLength: 25 }), async ops => {
        const { store, path } = freshStore()
        const model: number[] = []
        for (const x of ops) {
          await store().mutate(v => ({ items: [...v.items, x] }))
          model.push(x)
          const read = await store().read()
          if (JSON.stringify(read.items) !== JSON.stringify(model)) {
            throw new Error(`read diverged from the model after append(${x}) — ${path}`)
          }
        }
        const disk = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { items?: number[] }).items : []
        if (ops.length > 0 && JSON.stringify(disk) !== JSON.stringify(model)) {
          throw new Error(`durable bytes diverged from the model — ${path}`)
        }
      }),
      { numRuns: 25, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check('25 generated sequences: durable value ≡ sequential model (seed 20260807)', failure === '', failure.slice(0, 300))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — scheduler interleavings: concurrent mutates lose nothing, duplicate nothing')
{
  let failure = ''
  try {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 2, maxLength: 6 }), async (s, xs) => {
        const { store, path } = freshStore()
        // waitAll() settles the SCHEDULED promises only — the mutates chained
        // after them must be awaited explicitly or the read below races them.
        const jobs = xs.map((x, i) =>
          s
            .schedule(Promise.resolve(), `mutate-${i}`)
            .then(() => store().mutate(v => ({ items: [...v.items, x] }))),
        )
        await s.waitAll()
        await Promise.all(jobs)
        const final = await store().read()
        const gotSorted = [...final.items].sort((a, b) => a - b)
        const wantSorted = [...xs].sort((a, b) => a - b)
        if (JSON.stringify(gotSorted) !== JSON.stringify(wantSorted)) {
          throw new Error(`interleaved mutates lost/duplicated: got=[${final.items}] want-multiset=[${xs}] — ${path}`)
        }
      }),
      { numRuns: 25, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check('25 explored interleavings kept the exact submitted multiset (seed 20260807)', failure === '', failure.slice(0, 300))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — a generated corruption point quarantines + resumes from last-good (FC5)')
{
  let failure = ''
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 99 }),
        async (prefix, tail) => {
          const { store, path } = freshStore()
          for (const x of prefix) await store().mutate(v => ({ items: [...v.items, x] }))
          // Corrupt the durable copy AFTER the runtime witnessed the prefix.
          writeFileSync(guardWrite(root, path), '{ definitely not json')
          await store().mutate(v => ({ items: [...v.items, tail] }))
          const read = await store().read()
          if (JSON.stringify(read.items) !== JSON.stringify([...prefix, tail])) {
            throw new Error(`recovery lost the last-good witness: got=[${read.items}] want=[${[...prefix, tail]}] — ${path}`)
          }
          const dir = join(root, 'stores')
          // basename(), never split('/') — the round-2 windows-functional
          // red: backslashed win32 paths made the sibling prefix the whole
          // path and the quarantine was never "found".
          const quarantined = readdirSync(dir).some(n => n.startsWith(`${basename(path)}.damaged-`))
          if (!quarantined) throw new Error(`no quarantine copy beside ${path}`)
        },
      ),
      { numRuns: 15, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check(
    '15 generated corruption points: quarantine + last-good resume held (seed 20260807)',
    failure === '',
    failure.slice(0, 300),
  )
}

t.finish('prove-model-filestore')
