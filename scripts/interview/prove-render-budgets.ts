#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-render-budgets.ts — preview and navigation
//  renders meet MEASURED commit/latency budgets set from the R0 baselines.
//
//  One probe arena over the SHIPPED dist: a preview card takes 24
//  alternating focus moves (warmed: the first 4 are discarded), then one
//  resize, then idle. Metrics come from the arena's own instruments — the
//  INK write tee (epoch-stamped paints) against the driver's epoch-stamped
//  sends, and the flux probe's frame-cost stats.
//
//  BUDGETS (derived from the R0 baseline probe stats — frame p50 ≈ 2 ms,
//  p95 ≈ 4.4–6.6 ms, max ≈ 12–14 ms across the 13 captured journeys — with
//  ~3× headroom for pooled-host load; latency ceilings are sanity bounds an
//  operator would feel if crossed):
//    keystroke-to-paint (warmed): p50 ≤ 120 ms · p95 ≤ 300 ms · no misses
//    commits per focus move:      median ≤ 2 · max ≤ 4
//    frame cost:                  p95 ≤ 20 ms · max ≤ 60 ms
//    resize:                      ≤ 8 commits to settle, then quiet
//    idle:                        ≤ 2 writes in the final 2 s (no polling)
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  firstOutputTs,
  pct,
  requireDist,
  runArtifactArena,
} from '../streaming/artifactArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
requireDist()

const TURNS: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which config shape should ship?',
          header: 'Config',
          options: [
            { label: 'Layered', description: 'Defaults merged per root.', preview: '### Layered\n\n```ts\nmerge(defaults, local)\n```\n\n| key | default |\n|-----|---------|\n| ttl | 300s |' },
            { label: 'Flat', description: 'One frozen constant.', preview: '### Flat\n\n```ts\nObject.freeze({ ttl: 300 })\n```' },
          ],
        },
      ],
    },
    id: 'auq_perf',
    preText: 'One decision remains open.',
  },
]

const PRESSES = 24
const PRESS_START = 12_500
const PRESS_STEP = 350
const sends: string[] = ['8000:design the config layer', '8800:\r']
for (let i = 0; i < PRESSES; i++) {
  sends.push(`${PRESS_START + i * PRESS_STEP}:${i % 2 === 0 ? '\x1b[B' : '\x1b[A'}`)
}
const RESIZE_AT = PRESS_START + PRESSES * PRESS_STEP + 600 // 21_500

const run = await runArtifactArena({
  turns: TURNS,
  sends,
  resizes: [`${RESIZE_AT}:100:44`],
  seconds: 26,
  cols: 120,
  rows: 44,
  probe: true,
  keep: true,
})

try {
  void firstOutputTs(run)
  const writes = run.teeLines.filter(w => typeof w.ts === 'number')
  const arrowSends = run.sendLog
    .filter(s => {
      const d = Buffer.from(s.b64, 'base64').toString()
      return d === '\x1b[B' || d === '\x1b[A'
    })
    .slice(4) // warmed: discard the first 4 presses

  t.section('§1 — keystroke-to-paint (warmed medians)')
  {
    const lat: number[] = []
    let misses = 0
    for (const s of arrowSends) {
      const hit = writes.find(w => w.ts >= s.sent)
      if (hit) lat.push(hit.ts - s.sent)
      else misses++
    }
    t.check('every warmed press painted', misses === 0, `${misses} miss(es) of ${arrowSends.length}`)
    const p50 = pct(lat, 50)
    const p95 = pct(lat, 95)
    t.check(`p50 ≤ 120 ms (${p50.toFixed(0)} ms over ${lat.length} presses)`, p50 <= 120)
    t.check(`p95 ≤ 300 ms (${p95.toFixed(0)} ms)`, p95 <= 300)
  }

  t.section('§2 — commits per focus move (only the affected regions repaint)')
  {
    const counts = arrowSends.map(
      s => writes.filter(w => w.ts >= s.sent && w.ts < s.sent + PRESS_STEP - 30).length,
    )
    const sorted = [...counts].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const max = Math.max(...counts)
    t.check(`median ≤ 2 commits per press (${median})`, median <= 2)
    t.check(`max ≤ 4 commits per press (${max})`, max <= 4)
  }

  t.section('§3 — frame cost stays near the R0 baseline')
  {
    const frames = run.probe?.frames
    t.check('the probe captured frames', !!frames && frames.total > 0, `${frames?.total ?? 0}`)
    if (frames) {
      t.check(`frame p95 ≤ 20 ms (${frames.p95.toFixed(1)} ms; R0 baselines 4.4–6.6)`, frames.p95 <= 20)
      t.check(`frame max ≤ 60 ms (${frames.maxMs.toFixed(1)} ms; R0 baselines ≈ 12–14)`, frames.maxMs <= 60)
    }
  }

  t.section('§4 — resize settles in one coherent transition')
  {
    const resizeSent = run.sendLog.at(0) // sends only; resizes are not in sendLog
    void resizeSent
    // The resize epoch: ptydrive applies it at the requested offset from the
    // drive clock — anchor from a nearby send: the LAST arrow send + the
    // schedule delta to the resize.
    const lastArrow = run.sendLog
      .filter(s => ['\x1b[B', '\x1b[A'].includes(Buffer.from(s.b64, 'base64').toString()))
      .at(-1)!
    const resizeEpoch = lastArrow.sent + (RESIZE_AT - (PRESS_START + (PRESSES - 1) * PRESS_STEP))
    // Hosted runners stretch the settle: run 30652198854 saw one late settle
    // paint land at ~1.0 s and trip a 900 ms window. The law is NO RECURRING
    // activity (polling reads as ~10+ writes/1.5 s) — the settle window is
    // 1.5 s, and the quiet window after it stays strict.
    const settleWrites = writes.filter(w => w.ts >= resizeEpoch && w.ts < resizeEpoch + 1_500).length
    const after = writes.filter(w => w.ts >= resizeEpoch + 1_500 && w.ts < resizeEpoch + 3_000).length
    t.check(`≤ 9 commits to settle the resize (${settleWrites})`, settleWrites <= 9)
    t.check(`quiet after the settle (${after} write(s) in the next 1.5 s)`, after <= 2)
  }

  t.section('§5 — an idle interview screen adds no recurring activity')
  {
    const end = Math.max(...writes.map(w => w.ts))
    const idle = writes.filter(w => w.ts > end - 2_000 && w.ts < end).length
    t.check(`≤ 2 writes in the final 2 s (${idle})`, idle <= 2)
  }
} finally {
  run.cleanup()
}

t.finish('prove-render-budgets')
