#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import fc from 'fast-check'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

scratchRoot('cairn-model-purecores')
delete process.env.MERCURY_SELECTION_BUDGET

const t = checker()
const SEED = 20260807

const { emptyInterviewState, foldInterview, rebuildInterview } = await import(
  '../../src/services/interview/contracts.ts'
)
const { resolveSelectionBudget } = await import('../../src/services/run/contextSelection.ts')

type Ev = Parameters<typeof rebuildInterview>[0][number]

t.section('§1 — the fold: two-arm equivalence, replay-anywhere no-op, future kinds bounded')
{
  const QIDS = ['iq_a', 'iq_b']
  const opened: Ev[] = [
    { kind: 'session-opened', eventId: 'ie_open', atMs: 1, sessionId: 'is_pure', mission: 'pure' } as never,
    {
      kind: 'questions-presented',
      eventId: 'ie_pres',
      atMs: 2,
      round: 1,
      questions: QIDS.map(id => ({
        id,
        decisionId: `${id}_d`,
        text: id,
        header: 'H',
        options: [
          { id: `${id}_o1`, label: '1', description: 'one' },
          { id: `${id}_o2`, label: '2', description: 'two' },
        ],
        multiSelect: false,
      })),
    } as never,
  ]
  let n = 0
  const bodyArb = fc.oneof(
    fc.record({
      kind: fc.constant('navigated'),
      target: fc.constantFrom('review', 'iq_a', 'iq_b', 'iq_unknown'),
    }),
    fc.record({
      kind: fc.constant('answer-drafted'),
      questionId: fc.constantFrom(...QIDS, 'iq_unknown'),
      value: fc.record({ optionIds: fc.array(fc.constantFrom('iq_a_o1', 'iq_b_o2'), { maxLength: 2 }) }),
    }),
    fc.record({
      kind: fc.constant('answer-committed'),
      questionId: fc.constantFrom(...QIDS, 'iq_unknown'),
      value: fc.record({ optionIds: fc.array(fc.constantFrom('iq_a_o1', 'iq_b_o2'), { maxLength: 2 }) }),
    }),
    fc.record({
      kind: fc.constant('note-set'),
      questionId: fc.constantFrom(...QIDS),
      note: fc.string({ maxLength: 12 }),
    }),
  )
  const logArb = fc.array(bodyArb, { maxLength: 40 }).map(bodies => [
    ...opened,
    ...bodies.map(b => ({ ...b, eventId: `ie_g${++n}`, atMs: 100 + n }) as never as Ev),
  ])
  let failure = ''
  try {
    fc.assert(
      fc.property(logArb, fc.nat({ max: 60 }), fc.nat({ max: 60 }), (log, dupAtRaw, dupInsRaw) => {
        let pure = emptyInterviewState()
        for (const e of log) pure = foldInterview(pure, e)
        const rebuilt = rebuildInterview(log)
        if (JSON.stringify(pure) !== JSON.stringify(rebuilt)) {
          throw new Error('two-arm divergence: pure chain ≠ shared-set rebuild')
        }
        if (log.length > 0) {
          const dupAt = dupAtRaw % log.length
          const insAt = Math.min(log.length, dupAt + 1 + (dupInsRaw % (log.length - dupAt)))
          const withDup = [...log.slice(0, insAt), log[dupAt]!, ...log.slice(insAt)]
          if (JSON.stringify(rebuildInterview(withDup)) !== JSON.stringify(rebuilt)) {
            throw new Error(`replay of element ${dupAt} at ${insAt} moved state`)
          }
        }
        if (JSON.stringify(rebuildInterview(log)) !== JSON.stringify(rebuilt)) {
          throw new Error('rebuild is nondeterministic')
        }
        const alien = { kind: 'from-the-future', eventId: `ie_alien_${n}`, atMs: 9_999 } as never as Ev
        const withAlien = rebuildInterview([...log, alien])
        const seenDelta = withAlien.seenEventIds.size - rebuilt.seenEventIds.size
        if (seenDelta !== 1) throw new Error('future kind not recorded as seen exactly once')
        if (
          JSON.stringify({ ...withAlien, seenEventIds: 0 }) !== JSON.stringify({ ...rebuilt, seenEventIds: 0 })
        ) {
          throw new Error('future kind moved state (must be a bounded no-op)')
        }
      }),
      { numRuns: 150, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check('150 generated logs held all four fold laws (seed 20260807)', failure === '', failure.slice(0, 300))
}

t.section('§2 — resolveSelectionBudget is total, clamped, and identical-when-unset')
{
  let failure = ''
  try {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 20 }),
          fc.nat({ max: 40_000 }).map(String),
          fc.tuple(fc.nat({ max: 40_000 }), fc.nat({ max: 40_000 })).map(([a, b]) => `${a},${b}`),
        ),
        fc.option(fc.record({ maxOptionalItems: fc.nat({ max: 50 }) }), { nil: undefined }),
        (flagValue, caller) => {
          delete process.env.MERCURY_SELECTION_BUDGET
          const unset = resolveSelectionBudget(caller)
          if (caller && unset.budget !== caller) throw new Error('unset flag did not pass the caller budget through by reference')
          if (!caller && unset.budget !== null) throw new Error('unset flag with no caller must resolve null')
          process.env.MERCURY_SELECTION_BUDGET = flagValue
          const r = resolveSelectionBudget(caller)
          if (r.budget) {
            if (r.budget.maxOptionalItems < 0 || r.budget.maxOptionalItems > 10_000) {
              throw new Error(`clamp violated: ${r.budget.maxOptionalItems}`)
            }
            if (r.budget.maxTotalItems !== undefined && r.budget.maxTotalItems < r.budget.maxOptionalItems) {
              throw new Error('incoherent total bound kept')
            }
          }
          if (r.source === 'flag' && !/^\s*\d+(,\d+)?\s*$/.test(flagValue)) {
            throw new Error(`malformed '${flagValue}' claimed flag source`)
          }
          delete process.env.MERCURY_SELECTION_BUDGET
        },
      ),
      { numRuns: 200, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check('200 generated flag values held totality + clamps + the accepted default (seed 20260807)', failure === '', failure.slice(0, 300))
  delete process.env.MERCURY_SELECTION_BUDGET
}

t.finish('prove-model-purecores')
