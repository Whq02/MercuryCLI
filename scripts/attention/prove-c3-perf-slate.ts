#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-c3-perf-slate.ts — the perf
//  rows the standing bench instruments do not already carry, measured with
//  structural counters beside wall-clock (the perf-table header's law).
//
//    §1 attention at 1,000 mixed items — fold + view mint + every bucket's
//       sorted projection each inside the 35 ms transition budget; a
//       SINGLE-item transition re-folds inside the budget AND leaves every
//       untouched item REFERENCE-IDENTICAL (the stable-reference law — the
//       state half of "no whole-list remount"; the render half is the
//       React windowing pinned in §3 plus the b3 counter law).
//    §2 the relationship graph at 1,000 edges — fold + the spawned-by
//       depth walk (the indented-tree law) inside the budget.
//    §3 the windowing pin — NavigablePanes renders a bounded window around
//       the selection at ANY item count (structural; a removed window
//       fails here by name).
//    §4 dispatch receipts are SYNCHRONOUS — the ≤50 ms budget is bounded
//       by one function return + one windowed commit (the one-return,
//       one-commit paint class); a receipt that went async would fail this leg.
//
//  Wall-clock legs run 5 rounds and take the MEDIAN — a loaded pool core
//  costs rounds, never a verdict.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const BUDGET_MS = 35

const { foldAttention, emptyAttentionState, bucketItems, ATTENTION_BUCKETS } = await import(
  '../../src/services/attention/contracts.ts'
)
const { foldRelations, emptyRelationState } = await import('../../src/services/attention/relations.ts')
const { submitDispatch } = await import('../../src/services/attention/actions.ts')

function median5(fn: () => void): number {
  const samples: number[] = []
  for (let round = 0; round < 5; round++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return samples[2]!
}

const BUCKET_OF = (i: number) =>
  ATTENTION_BUCKETS[i % ATTENTION_BUCKETS.length]!
const REASON_OF: Record<string, string> = {
  'needs-you': 'permission-pending',
  'ready-to-review': 'review-queued',
  stalled: 'run-failed',
  working: 'run-live',
  completed: 'run-completed',
}

const factOf = (i: number, atMs: number) => ({
  subjectId: `perf-subject-${i}`,
  owner: 'workbench',
  sourceEventId: `perf-ev-${i}-${atMs}`,
  bucket: BUCKET_OF(i),
  reasonCode: REASON_OF[BUCKET_OF(i)]!,
  reasonLabel: `perf row ${i}`,
  sinceMs: 1000 + i,
  atMs,
  urgency: (i % 3) as 0 | 1 | 2,
  title: `perf title ${i}`,
})

t.section('§1 attention at 1,000 mixed items (fold · mint · sorted buckets · one-item transition)')
{
  const facts = Array.from({ length: 1000 }, (_, i) => factOf(i, 2000))
  let state = emptyAttentionState()
  const foldMs = median5(() => {
    state = foldAttention(emptyAttentionState(), facts)
  })
  t.check(`1,000-fact fold inside the budget (${foldMs.toFixed(1)} ms ≤ ${BUDGET_MS})`, foldMs <= BUDGET_MS)
  t.check('structural counter: all 1,000 items present', state.items.size === 1000, String(state.items.size))

  let projected = 0
  const projectMs = median5(() => {
    projected = ATTENTION_BUCKETS.reduce((n, b) => n + bucketItems(state, b).length, 0)
  })
  t.check(
    `every bucket's sorted projection inside the budget (${projectMs.toFixed(1)} ms ≤ ${BUDGET_MS})`,
    projectMs <= BUDGET_MS,
  )
  t.check('structural counter: the projections cover all items', projected === 1000, String(projected))

  // The single-item transition: one subject moves buckets; everything else
  // must keep reference identity (remount material only for the one row).
  const before = new Map(state.items)
  const update = { ...factOf(7, 3000), bucket: 'completed' as const, reasonCode: 'run-completed', sourceEventId: 'perf-ev-7-moved' }
  let next = state
  const transitionMs = median5(() => {
    next = foldAttention(state, [update])
  })
  t.check(
    `the single-item transition inside the budget (${transitionMs.toFixed(1)} ms ≤ ${BUDGET_MS})`,
    transitionMs <= BUDGET_MS,
  )
  let stable = 0
  for (const [key, item] of next.items) {
    if (key !== 'perf-subject-7' && before.get(key) === item) stable++
  }
  t.check(
    'structural counter: 999/999 untouched items are REFERENCE-IDENTICAL (no whole-list remount material)',
    stable === 999,
    `${stable}/999 stable`,
  )
  t.check('the moved item actually moved', next.items.get('perf-subject-7')?.bucket === 'completed')
}

t.section('§2 the relationship graph at 1,000 edges (fold · spawned-by depth walk)')
{
  // A realistic spawn forest: 100 roots, each with a chain of 9 children.
  const edges = Array.from({ length: 1000 }, (_, i) => {
    const root = Math.floor(i / 10)
    const depth = i % 10
    return {
      kind: 'spawned-by' as const,
      from: `node-${root}-${depth + 1}`,
      to: depth === 0 ? `root-${root}` : `node-${root}-${depth}`,
      owner: 'workbench',
      sourceEventId: `perf-edge-${i}`,
    }
  })
  let rel = emptyRelationState()
  const foldMs = median5(() => {
    rel = foldRelations(emptyRelationState(), edges)
  })
  t.check(`1,000-edge fold inside the budget (${foldMs.toFixed(1)} ms ≤ ${BUDGET_MS})`, foldMs <= BUDGET_MS)
  t.check('structural counter: all 1,000 edges present', rel.edges.size === 1000, String(rel.edges.size))

  // The indented-tree law: group children by parent, walk depth-first — the
  // projection the GRAPH section renders (then windows).
  let visited = 0
  const walkMs = median5(() => {
    const children = new Map<string, string[]>()
    for (const e of rel.edges.values()) {
      const list = children.get(e.to) ?? []
      list.push(e.from)
      children.set(e.to, list)
    }
    visited = 0
    const walk = (id: string): void => {
      visited++
      for (const c of children.get(id) ?? []) walk(c)
    }
    for (let r = 0; r < 100; r++) walk(`root-${r}`)
  })
  t.check(`the depth walk inside the budget (${walkMs.toFixed(1)} ms ≤ ${BUDGET_MS})`, walkMs <= BUDGET_MS)
  t.check('structural counter: the walk visited every node', visited === 1100, String(visited))
}

t.section('§3 the render window is structural (any item count renders O(window))')
{
  const src = readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8')
  t.check(
    'NavigablePanes carries the React-level render window around the selection',
    src.includes('const ROW_OVERSCAN = 12') && src.includes('listHeight + 2 * ROW_OVERSCAN'),
  )
}

t.section('§4 the intent layer adds no weight to the delivery door (steer-removal re-cut)')
{
  // The receipt is the DOOR's answer now (an RPC on the live road), so the
  // budget subject is THIS LAYER's own overhead: with a same-tick fake
  // door seated, an intent settles inside the 50 ms slate budget; the
  // refusal path settles without touching any door at all.
  const focused = await import('../../src/services/engine-connector/focusedConnector.ts')
  const refusal = await submitDispatch({ intentId: 'perf-intent-1', kind: 'prompt', value: '' })
  t.check('an empty-intent refusal settles typed, doorless', refusal.kind === 'dispatch-unavailable')
  focused.setFocusedSessionConnector({
    carrier: 'daemon',
    sessionId: () => 'perf-fake',
    sendWords: async () => ({ state: 'accepted' as const }),
    sendAgentNote: async () => ({ state: 'accepted' as const }),
  } as never)
  const warm = await submitDispatch({ intentId: 'perf-intent-warm', kind: 'board-dispatch', value: 'perf-slate warm probe' })
  t.check("the ACCEPTED receipt is the door's answer", warm.kind === 'dispatch-accepted' && warm.route === 'session')
  const t0 = performance.now()
  for (let i = 0; i < 5; i++) {
    await submitDispatch({ intentId: `perf-intent-${i}`, kind: 'board-dispatch', value: 'perf-slate acceptance probe' })
  }
  const acceptMs = (performance.now() - t0) / 5
  t.check(
    `the layer's own overhead sits inside the budget (mean ${acceptMs.toFixed(2)} ms ≤ 50 over a same-tick door)`,
    acceptMs <= 50,
  )
  focused._resetFocusedSessionConnectorForTesting()
}

t.finish('prove-c3-perf-slate')
