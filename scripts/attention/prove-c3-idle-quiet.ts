#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-c3-idle-quiet.ts — idle means
//  ZERO polling.
//
//  The row's contract: "Zero polling after settlement; ≤1
//  housekeeping render in a measured 10 s quiet window absent owner events."
//  Two halves:
//
//    §1 STRUCTURAL — the owners contain NO setInterval, and every
//       setTimeout callsite is one of the PINNED event-armed classes (a
//       debounce a keystroke arms, or the view's burst window an owner event
//       arms behind a listeners-guard). A new timer class fails the census
//       by name — polling cannot land silently.
//    §2 MEASURED — the armed attention machinery is watched through a REAL
//       10-second wall-clock quiet window (time IS the contract here): with
//       a registered gatherer and a subscribed view and NO owner events,
//       the gatherer is never re-gathered, the store never recomputes into
//       a change, and the view emits ZERO notifications.
//
//  Born-green LAW PIN (the prove-b3-cards precedent): is a design row
//  without a defect reproducer; this pins the law forever in the pool.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

// ── §1 structural census ────────────────────────────────────────────────────
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
    // The WORK/workbench board retired in place;
    // the prompts panel took its slot and adds no timer.
    'src/components/prompts-panel/PromptsPanel.tsx',
    // The workbench projection engine PRE-DATES this but the
    // attention view rides it — its timers are in the census, pinned, not
    // hidden (wave-C review: an excluded owner is a hole, not a pass).
    'src/services/workbench/projection.ts',
  ]
  /** The pinned event-armed classes — file → the exact timers allowed. */
  const ALLOWED_SET_TIMEOUT: Record<string, number> = {
    // The view's burst window: armed only by an owner/statusFeed event and
    // only while a listener exists (dormancy-guarded); unref'd.
    'src/services/attention/viewModel.ts': 1,
    // The main-draft + scoped-docs debounced write-throughs: keystrokes arm
    // them; an idle session schedules nothing.
    'src/utils/promptDraft.ts': 2,
    // The projection's change-coalescing debounce (subscriber-armed).
    'src/services/workbench/projection.ts': 1,
  }
  /** setInterval is allowed NOWHERE except the one disclosed pre-existing
   *  engine heartbeat: the workbench projection's slow refresh, armed ONLY
   *  while a consumer subscribes and torn down with the last one — the
   *  surfaces themselves add zero intervals. */
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
  // The heartbeat's dormancy guard is structural: it arms in the subscribe
  // path and the teardown clears it when subscribers reach zero.
  const proj = readFileSync('src/services/workbench/projection.ts', 'utf8')
  t.check(
    'the projection heartbeat is subscriber-armed with a teardown (dormancy holds)',
    /heartbeat\s*=\s*setInterval/.test(proj) && /clearInterval\(heartbeat\)/.test(proj),
  )
}

// ── §2 the measured quiet window ────────────────────────────────────────────
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
    // The family's change seam: NEVER fires in this proof — no owner events.
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
  // Deadline loop on ONE monotonic clock: a timer may fire a hair early
  // relative to any cross-clock sample (a hosted run measured 9999 ms via
  // Date.now), so the wait re-arms until the measuring clock itself has
  // passed the window — elapsed ≥ windowMs holds by construction.
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
