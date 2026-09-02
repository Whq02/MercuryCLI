#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-attention-fold.ts — A1: the attention
//  fold's laws.
//
//  EXPECT-RED at the pre-fix tree (recorded in the journal), promoted to a
//  standing proof in the same commit as the fold — the way.
//
//  Laws pinned here:
//    §1 vocabulary — the five buckets, exact and ordered.
//    §2 OWNER-TRUTH — the fold never invents: every item's bucket, reasonCode
//       and sourceEventId are exactly some fact's; fold([]) is empty.
//    §3 SILENCE-NEVER-STALLS — no time-based transition lives in the fold: an
//       ancient working fact stays working; folding nothing later changes
//       nothing (stalled requires an explicit owner fact).
//    §4 IDEMPOTENT REPLAY — folding the same facts twice ≡ once.
//    §5 REBUILT ≡ LIVE — one-shot fold ≡ incremental fold (the equivalence
//       law accelerators must obey).
//    §6 STABLE IDENTITY — a later fact MOVES the subject between buckets
//       (one item, same id), never duplicates it.
//    §7 SORT — urgency → waiting-time (longest first) → stable id; never
//       primarily recency.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/services/attention/contracts.ts') | null = null
try {
  m = await import('../../src/services/attention/contracts.ts')
} catch {
  m = null
}
if (!m) {
  t.check('src/services/attention/contracts.ts loads', false, 'module absent')
  t.finish('prove-attention-fold')
}
const mod = m!

t.section('§1 — vocabulary')
t.check(
  'ATTENTION_BUCKETS is exactly the five, in order',
  JSON.stringify(mod.ATTENTION_BUCKETS) ===
    JSON.stringify(['needs-you', 'ready-to-review', 'stalled', 'working', 'completed']),
)

const fact = (
  subjectId: string,
  bucket: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  subjectId,
  owner: 'run-manifest',
  sourceEventId: `ev-${subjectId}-${bucket}`,
  bucket,
  reasonCode: 'run-paused',
  reasonLabel: 'paused by the operator',
  sinceMs: 1_000,
  atMs: 2_000,
  urgency: 1,
  ...over,
})

t.section('§2 — owner truth')
{
  const empty = mod.foldAttention(mod.emptyAttentionState(), [])
  t.check('fold([]) is empty', mod.attentionItems(empty).length === 0)
  const s = mod.foldAttention(
    mod.emptyAttentionState(),
    [fact('run:a', 'needs-you', { reasonCode: 'question-pending', urgency: 0 })] as never,
  )
  const items = mod.attentionItems(s)
  t.check('one fact ⇒ one item', items.length === 1)
  const it = items[0]!
  t.check(
    'the item carries the fact\'s bucket + reasonCode + sourceEventId verbatim',
    it.bucket === 'needs-you' &&
      it.reasonCode === 'question-pending' &&
      it.sourceEventId === 'ev-run:a-needs-you',
  )
}

t.section('§3 — silence never stalls')
{
  const ancient = fact('run:old', 'working', {
    reasonCode: 'run-live',
    sinceMs: 1,
    atMs: 1,
    urgency: 2,
  })
  const s1 = mod.foldAttention(mod.emptyAttentionState(), [ancient] as never)
  const s2 = mod.foldAttention(s1, [])
  const it = mod.attentionItems(s2)[0]!
  t.check('an ancient working item is STILL working after a later empty fold', it.bucket === 'working')
  t.check(
    'folding nothing changes nothing (no time-based transitions in the fold)',
    JSON.stringify(mod.attentionItems(s1)) === JSON.stringify(mod.attentionItems(s2)),
  )
}

t.section('§4 — idempotent replay')
{
  const F = [
    fact('run:a', 'needs-you', { reasonCode: 'question-pending', urgency: 0 }),
    fact('ticket:b', 'stalled', { owner: 'work-queue', reasonCode: 'dependency-blocked' }),
  ] as never[]
  const once = mod.foldAttention(mod.emptyAttentionState(), F as never)
  const twice = mod.foldAttention(once, F as never)
  t.check(
    'the same facts folded twice ≡ once',
    JSON.stringify(mod.attentionItems(once)) === JSON.stringify(mod.attentionItems(twice)),
  )
}

t.section('§5 — rebuilt ≡ live-incremental')
{
  const F = [
    fact('run:a', 'working', { reasonCode: 'run-live', urgency: 2 }),
    fact('run:a', 'needs-you', {
      reasonCode: 'permission-pending',
      urgency: 0,
      atMs: 3_000,
      sourceEventId: 'ev-perm-1',
    }),
    fact('ticket:b', 'ready-to-review', { owner: 'review-queue', reasonCode: 'review-queued', urgency: 1 }),
  ] as never[]
  const oneShot = mod.foldAttention(mod.emptyAttentionState(), F as never)
  const incremental = (F as never[]).reduce(
    (s, f) => mod.foldAttention(s, [f] as never),
    mod.emptyAttentionState(),
  )
  t.check(
    'one-shot fold ≡ incremental fold',
    JSON.stringify(mod.attentionItems(oneShot)) === JSON.stringify(mod.attentionItems(incremental)),
  )
}

t.section('§6 — stable identity across bucket moves')
{
  const s1 = mod.foldAttention(
    mod.emptyAttentionState(),
    [fact('run:a', 'working', { reasonCode: 'run-live', urgency: 2 })] as never,
  )
  const s2 = mod.foldAttention(
    s1,
    [
      fact('run:a', 'needs-you', {
        reasonCode: 'question-pending',
        urgency: 0,
        atMs: 5_000,
        sourceEventId: 'ev-q1',
      }),
    ] as never,
  )
  const items = mod.attentionItems(s2)
  t.check('the move produced ONE item (no duplicate)', items.length === 1)
  t.check(
    'same subjectId, new bucket, new source event',
    items[0]!.subjectId === 'run:a' &&
      items[0]!.bucket === 'needs-you' &&
      items[0]!.sourceEventId === 'ev-q1',
  )
}

t.section('§7 — the sort law')
{
  const items = mod.attentionItems(
    mod.foldAttention(
      mod.emptyAttentionState(),
      [
        fact('z:recent-urgent', 'needs-you', { urgency: 0, sinceMs: 9_000, atMs: 9_500 }),
        fact('a:old-urgent', 'needs-you', { urgency: 0, sinceMs: 100, atMs: 9_600 }),
        fact('m:calm', 'working', { bucket: 'working', reasonCode: 'run-live', urgency: 2, sinceMs: 50 }),
        fact('b:old-urgent-tie', 'needs-you', { urgency: 0, sinceMs: 100, atMs: 9_700 }),
      ] as never,
    ),
  )
  const sorted = mod.sortAttention(items, 10_000)
  const ids = sorted.map((i: { subjectId: string }) => i.subjectId)
  t.check(
    'urgency first, then LONGEST-waiting, then stable id — never recency',
    JSON.stringify(ids) ===
      JSON.stringify(['a:old-urgent', 'b:old-urgent-tie', 'z:recent-urgent', 'm:calm']),
    ids.join(' · '),
  )
}

t.finish('prove-attention-fold')
