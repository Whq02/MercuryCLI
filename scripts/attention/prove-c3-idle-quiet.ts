#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('§1 timer census over the rendezvous owners (no polling class exists)')
{
  const OWNERS = [
    'src/services/attention/contracts.ts',
    'src/services/attention/store.ts',
    'src/services/attention/viewModel.ts',
    'src/services/attention/actions.ts',
    'src/services/attention/relations.ts',
    'src/services/workbench/attentionBridge.ts',
    'src/services/workbench/returnState.ts',
    'src/services/workbench/folioActions.ts',
    'src/input-core/composer-document.ts',
    'src/input-core/command-queue.ts',
    'src/utils/promptDraft.ts',
    'src/components/prompts-panel/PromptsPanel.tsx',
    'src/services/workbench/projection.ts',
  ]
  const ALLOWED_SET_TIMEOUT: Record<string, number> = {
    'src/services/attention/viewModel.ts': 1,
    'src/utils/promptDraft.ts': 2,
    'src/services/workbench/projection.ts': 1,
  }
  const ALLOWED_SET_INTERVAL: Record<string, number> = {
    'src/services/workbench/projection.ts': 1,
  }
  for (const file of OWNERS) {
    const src = readFileSync(file, 'utf8')
    const intervals = [...src.matchAll(/setInterval\(/g)].length
    const allowedIntervals = ALLOWED_SET_INTERVAL[file] ?? 0
    t.check(
      `${file}: setInterval callsites = ${allowedIntervals}`,
      intervals === allowedIntervals,
      `found ${intervals}`,
    )
    const timeouts = [...src.matchAll(/setTimeout\(/g)].length
    const allowed = ALLOWED_SET_TIMEOUT[file] ?? 0
    t.check(
      `${file}: setTimeout callsites = ${allowed} (the pinned event-armed set)`,
      timeouts === allowed,
      `found ${timeouts}`,
    )
  }
  const proj = readFileSync('src/services/workbench/projection.ts', 'utf8')
  t.check(
    'the projection heartbeat is subscriber-armed with a teardown (dormancy holds)',
    /heartbeat\s*=\s*setInterval/.test(proj) && /clearInterval\(heartbeat\)/.test(proj),
  )
}

t.section('§2 a REAL 10 s quiet window: armed, event-free, and completely silent')
{
  const { registerAttentionGatherer } = await import('../../src/services/attention/store.ts')
  const { subscribeAttentionView, cachedAttentionView } = await import(
    '../../src/services/attention/viewModel.ts'
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
