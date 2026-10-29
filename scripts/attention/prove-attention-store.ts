#!/usr/bin/env bun
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
type Fact = import('../../src/services/attention/contracts.ts').AttentionFact

const cmd = (value: string, mode: string): Record<string, unknown> => ({ value, mode })

function owner(): { facts: Fact[]; fire: () => void; subscribe: (cb: () => void) => () => void; subscribers: () => number } {
  const facts: Fact[] = []
  const listeners = new Set<() => void>()
  return {
    facts,
    fire: () => {
      for (const cb of [...listeners]) cb()
    },
    subscribe: cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    subscribers: () => listeners.size,
  }
}

t.section('§1 — solo dormancy')
{
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  q.resetCommandQueue()
  const seam = owner()
  S.registerAttentionGatherer(() => ({ attention: seam.facts }), { subscribe: seam.subscribe })
  t.check('nothing armed before the first subscriber', S._attentionStoreStateForTesting().armed === false)
  t.check("a registered owner's seam is not tapped while dormant", seam.subscribers() === 0, String(seam.subscribers()))
  const un = V.subscribeAttentionView(() => {})
  t.check('the first VIEW subscriber arms the store taps', S._attentionStoreStateForTesting().armed === true)
  t.check("…and taps the owner's seam", seam.subscribers() === 1, String(seam.subscribers()))
  un()
  t.check('the last unsubscribe disarms the store', S._attentionStoreStateForTesting().armed === false)
  t.check("…and lets go of the owner's seam", seam.subscribers() === 0, String(seam.subscribers()))
  t.check('no view timer after teardown', V._attentionViewStateForTesting().timerArmed === false)
}

t.section('§2 — owner truth end-to-end (an owner fact → needs-you → settled by the owner)')
{
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  const seam = owner()
  S.registerAttentionGatherer(() => ({ attention: seam.facts }), { subscribe: seam.subscribe })
  const un = V.subscribeAttentionView(() => {})
  const at = Date.now()
  seam.facts.push({ subjectId: 'ask:1', owner: 'obligations', sourceEventId: 'obligation:ask:1', bucket: 'needs-you', reasonCode: 'permission-pending', reasonLabel: 'a seat is asking', sinceMs: at, atMs: at, urgency: 0 })
  seam.fire()
  const v1 = V.cachedAttentionView()
  t.check('one owner fact ⇒ needsYou 1', v1.needsYou === 1, String(v1.needsYou))
  const it = [...v1.attention.items.values()].find(i => i.subjectId === 'ask:1')
  t.check(
    'the item carries the owner receipt (owner + source id + urgency 0)',
    it !== undefined && it.owner === 'obligations' && it.sourceEventId === 'obligation:ask:1' && it.urgency === 0,
    it ? `${it.owner} ${it.sourceEventId}` : 'absent',
  )
  seam.facts.splice(0, seam.facts.length, { subjectId: 'ask:1', owner: 'obligations', sourceEventId: 'obligation-settled:ask:1', bucket: 'completed', reasonCode: 'settled', reasonLabel: 'the seat was answered', sinceMs: at, atMs: at + 1, urgency: 2 })
  seam.fire()
  const v2 = V.cachedAttentionView()
  t.check("the owner's terminal fact settles it BY OWNER EVENT ⇒ needsYou 0", v2.needsYou === 0, String(v2.needsYou))
  const settled = [...v2.attention.items.values()].find(i => i.subjectId === 'ask:1')
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
  const seam = owner()
  S.registerAttentionGatherer(() => ({ attention: seam.facts }), { subscribe: seam.subscribe })
  const un = V.subscribeAttentionView(() => {})
  const a = V.cachedAttentionView()
  const b = V.cachedAttentionView()
  t.check('two reads with no change ⇒ the SAME object', a === b)
  seam.fire()
  const c = V.cachedAttentionView()
  t.check('an owner seam firing with unchanged facts folds to a no-op ⇒ the reference survives', c === a)
  un()
}

t.section('§4 — the command queue is not an owner the store reads')
{
  S.resetAttentionStoreForTesting()
  V.resetAttentionViewForTesting()
  q.resetCommandQueue()
  const un = V.subscribeAttentionView(() => {})
  const before = V.cachedAttentionView()
  q.enqueue(cmd('a plain prompt', 'prompt') as never)
  q.enqueue(cmd('<task-notification>a shell finished</task-notification>', 'task-notification') as never)
  q.enqueue(cmd('Bash: git push --force', 'bash') as never)
  const after = V.cachedAttentionView()
  t.check('queued commands of every mode reach no bucket — needsYou 0', after.needsYou === 0 && after.attention.items.size === 0, `${after.needsYou} · ${after.attention.items.size} item(s)`)
  t.check('…and move nothing: the reference survives the queue', after === before)
  q.dequeue()
  q.remove(q.getCommandQueue())
  t.check("the queue's consumption moves nothing either", V.cachedAttentionView() === before)
  un()
  q.resetCommandQueue()
}

t.finish('prove-attention-store')
