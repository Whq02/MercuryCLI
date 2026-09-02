#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-attention-store.ts — A1: the attention
//  store + view-model (mechanics: one store, stable reference, solo
//  dormancy, owner-truth gatherers with honest terminals).
//
//  EXPECT-RED at the pre-fix tree (the modules are the fix), promoted to a
//  standing proof in the same commit.
//
//    §1 SOLO DORMANCY — nothing armed before the first subscriber; the last
//       unsubscribe tears down the queue taps and the view timer.
//    §2 OWNER TRUTH end-to-end — an orphaned permission entering the REAL
//       command queue becomes ONE needs-you item carrying the owner receipt;
//       its consumption (dequeue) settles it to completed BY OWNER EVENT —
//       the item leaves the bucket honestly, never by silence.
//    §3 STABLE REFERENCE — reads return the same snapshot object across
//       no-ops (a non-permission queue change folds to a no-op and the view
//       reference survives).
//    §4 DISCARD HONESTY — a cleared queue reports the permission as
//       discarded (completed, never counted as consumed-ran).
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let store: typeof import('../../src/services/attention/store.ts') | null = null
let view: typeof import('../../src/services/attention/viewModel.ts') | null = null
try {
  store = await import('../../src/services/attention/store.ts')
  view = await import('../../src/services/attention/viewModel.ts')
} catch {
  store = null
  view = null
}
if (!store || !view) {
  t.check('attention store + viewModel load', false, 'modules absent')
  t.finish('prove-attention-store')
}
const S = store!
const V = view!
const q = await import('../../src/input-core/command-queue.ts')

const cmd = (value: string, mode: string): Record<string, unknown> => ({ value, mode })

t.section('§1 — solo dormancy')
{
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  q.resetCommandQueue()
  t.check('nothing armed before the first subscriber', S._attentionStoreStateForTesting().armed === false)
  const un = V.subscribeAttentionView(() => {})
  t.check('the first VIEW subscriber arms the store taps', S._attentionStoreStateForTesting().armed === true)
  un()
  t.check('the last unsubscribe disarms the store', S._attentionStoreStateForTesting().armed === false)
  t.check('no view timer after teardown', V._attentionViewStateForTesting().timerArmed === false)
}

t.section('§2 — owner truth end-to-end (queued permission → needs-you → settled)')
{
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  q.resetCommandQueue()
  const un = V.subscribeAttentionView(() => {})
  q.enqueue(cmd('Bash: rm -rf build', 'orphaned-permission') as never)
  const v1 = V.cachedAttentionView()
  t.check('one orphaned permission ⇒ needsYou 1', v1.needsYou === 1, String(v1.needsYou))
  const items = [...v1.attention.items.values()]
  const it = items.find(i => i.reasonCode === 'permission-orphaned')
  t.check(
    'the item carries the owner receipt (command-queue + queue: source id + urgency 0)',
    it !== undefined && it.owner === 'command-queue' && it.sourceEventId.startsWith('queue:perm:') && it.urgency === 0,
    it ? `${it.owner} ${it.sourceEventId}` : 'absent',
  )
  q.dequeue()
  const v2 = V.cachedAttentionView()
  t.check('consumption settles it BY OWNER EVENT ⇒ needsYou 0', v2.needsYou === 0, String(v2.needsYou))
  const settled = [...v2.attention.items.values()].find(i => i.subjectId === it?.subjectId)
  t.check(
    "the item moved to completed/'settled' (honest terminal, not a silent vanish)",
    settled !== undefined && settled.bucket === 'completed' && settled.reasonCode === 'settled',
    settled ? `${settled.bucket}/${settled.reasonCode}` : 'gone',
  )
  un()
}

t.section('§3 — stable reference across no-ops')
{
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  q.resetCommandQueue()
  const un = V.subscribeAttentionView(() => {})
  const a = V.cachedAttentionView()
  const b = V.cachedAttentionView()
  t.check('two reads with no change ⇒ the SAME object', a === b)
  q.enqueue(cmd('a plain prompt', 'prompt') as never)
  const c = V.cachedAttentionView()
  t.check(
    'a non-permission queue change folds to a no-op ⇒ the reference survives',
    c === a,
  )
  un()
  q.resetCommandQueue()
}

t.section('§4 — leave honesty (steer-removal re-cut: the ESC-clear verb died with the pen)')
{
  // The 'cleared'/'popped' provenance kinds survive as defensive
  // vocabulary, but their operator-facing producers (ESC-clear, the
  // pop-backs, replaceNext) retired with the holding pen — the surviving
  // leave roads are 'dequeued' (the driver ran it) and 'removed' (the
  // drain consumed it), both RAN. The permission leaves honestly by owner
  // event, never by silence.
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  q.resetCommandQueue()
  const un = V.subscribeAttentionView(() => {})
  q.enqueue(cmd('Bash: git push --force', 'orphaned-permission') as never)
  t.check('(rig) queued ⇒ needsYou 1', V.cachedAttentionView().needsYou === 1)
  q.remove(q.getCommandQueue())
  const v = V.cachedAttentionView()
  t.check(
    'an identity removal (the drain road) retires the item — needsYou 0, by owner event',
    v.needsYou === 0,
    String(v.needsYou),
  )
  un()
  q.resetCommandQueue()
}

t.finish('prove-attention-store')
