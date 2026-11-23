#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()


t.section('§2 a REAL 10 s quiet window: armed, event-free, and completely silent')
{
  const { registerAttentionGatherer } = await import('../../src/screen/attention/store.ts')
  const { subscribeAttentionView, cachedAttentionView } = await import(
    '../../src/screen/attention/viewModel.ts'
  )

  let gatherCalls = 0
  const unregister = registerAttentionGatherer(
    () => {
      gatherCalls++
      return { attention: [], relations: [] }
    },
    { subscribe: () => () => {} },
  )

  let notifications = 0
  const unsub = subscribeAttentionView(() => {
    notifications++
  })
  const view0 = cachedAttentionView()
  const gatherAfterArm = gatherCalls
  t.check('arming gathered at least once (the arm recompute)', gatherAfterArm >= 1, String(gatherAfterArm))

  const windowMs = 10_000
  const t0 = performance.now()
  let elapsed = 0
  for (;;) {
    elapsed = Math.floor(performance.now() - t0)
    const remaining = windowMs - elapsed
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, remaining))
  }

  t.check(`the quiet window really elapsed (${elapsed} ms ≥ ${windowMs})`, elapsed >= windowMs)
  t.check(
    'ZERO re-gathers in the window — nothing polled the owner family',
    gatherCalls === gatherAfterArm,
    `${gatherCalls - gatherAfterArm} extra gather(s)`,
  )
  t.check('ZERO view notifications in the window', notifications === 0, String(notifications))
  const view1 = cachedAttentionView()
  t.check(
    'the view is reference-stable across the window (no phantom repaint material)',
    view1 === view0,
  )

  unsub()
  unregister()
}

t.finish('prove-c3-idle-quiet')
