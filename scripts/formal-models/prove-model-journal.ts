#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/prove-model-journal.ts — (R2): the
//  operation journal under GENERATED operation sequences against a
//  reference model.
//
//    §1 generated sequences of journaled operations (1–4 steps each; keys
//       drawn from a small pool so REPLAYS occur; a generated die-at-step
//       makes aborts occur): committed keys replay their ORIGINAL result
//       without re-executing a single step; aborted keys re-run fresh;
//       every journal record ends TERMINAL; a final recoverJournalDir over
//       the dir finds nothing pending (the crash-recovery floor for real
//       process death is owned deterministically by
//       scripts/reliability/prove-operation-journal.ts — this layer
//       generates the LIVE-path laws).
//
//  Fixed seed; failures print fast-check's seed + path + shrunk sequence.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-model-journal')
const t = checker()
const SEED = 20260807

const { listJournalOperations, recoverJournalDir, runJournaledOperation } = await import(
  '../../src/substrate/operationJournal.ts'
)

let serial = 0

t.section('§1 — generated operation sequences: replay, abort, terminality, quiet recovery')
{
  let failure = ''
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            key: fc.constantFrom('k1', 'k2', 'k3', 'k4'),
            stepCount: fc.integer({ min: 1, max: 4 }),
            dieAtStep: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
            payload: fc.integer({ min: 0, max: 999 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async ops => {
          const dir = join(root, `j-${++serial}`)
          const work = join(root, `w-${serial}`)
          mkdirSync(work, { recursive: true })
          // The model: key → the FIRST committed result (replay law), or
          // 'aborted' (re-runnable).
          const committed = new Map<string, number>()
          const stepRuns = new Map<string, number>()
          for (const op of ops) {
            const die = op.dieAtStep !== null && op.dieAtStep < op.stepCount
            const steps = Array.from({ length: op.stepCount }, (_, i) => ({
              id: `s${i}`,
              target: join(work, `${op.key}-s${i}`),
              run: async () => {
                stepRuns.set(op.key, (stepRuns.get(op.key) ?? 0) + 1)
                if (die && i === op.dieAtStep) throw new Error(`generated die at step ${i}`)
              },
            }))
            const runsBefore = stepRuns.get(op.key) ?? 0
            let outcome: string
            let result: unknown
            try {
              const r = await runJournaledOperation({
                journalDir: dir,
                ownerKey: 'model-owner',
                kind: 'cairn-model-op',
                idempotencyKey: op.key,
                steps,
                result: () => ({ v: op.payload }),
              })
              outcome = r.outcome
              result = r.result
            } catch {
              outcome = 'threw'
              result = null
            }
            const wasCommitted = committed.has(op.key)
            if (wasCommitted) {
              // THE REPLAY LAW: the original result, zero step executions.
              if (outcome !== 'replayed') throw new Error(`committed key ${op.key} did not replay (${outcome})`)
              if ((result as { v: number }).v !== committed.get(op.key)) {
                throw new Error(`replay of ${op.key} returned a different result`)
              }
              if ((stepRuns.get(op.key) ?? 0) !== runsBefore) {
                throw new Error(`replay of ${op.key} re-executed steps`)
              }
            } else if (!die) {
              if (outcome !== 'committed') throw new Error(`clean op ${op.key} did not commit (${outcome})`)
              committed.set(op.key, op.payload)
            } else {
              if (outcome === 'committed' || outcome === 'replayed') {
                throw new Error(`dying op ${op.key} claimed ${outcome}`)
              }
              // aborted (or threw) — the key stays re-runnable.
            }
          }
          // Terminality: every journal record is terminal; recovery is quiet.
          const records = await listJournalOperations(dir)
          const nonTerminal = records.filter(r => r.state !== 'committed' && r.state !== 'aborted')
          if (nonTerminal.length > 0) {
            throw new Error(`non-terminal journal records: ${nonTerminal.map(r => `${r.idempotencyKey}:${r.state}`)}`)
          }
          const summary = await recoverJournalDir(dir, {})
          const touched = JSON.stringify(summary)
          if (/rolledForward":\s*[1-9]|compensated":\s*[1-9]/.test(touched)) {
            throw new Error(`recovery found pending work after live-path terminality: ${touched}`)
          }
        },
      ),
      { numRuns: 30, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check(
    '30 generated operation sequences held replay/abort/terminality + quiet recovery (seed 20260807)',
    failure === '',
    failure.slice(0, 400),
  )
}

t.finish('prove-model-journal')
