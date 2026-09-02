#!/usr/bin/env bun
// prove-ctx-forecast.ts — locks the P7 '≈N turns to autocompact' estimator
// (utils/cockpit/ctxForecast.ts): honest-null warmup, growth-rate math,
// compaction reset, and the gate (default-ON since, ladder
// tier `display`; =0 ⇒ inert by construction).

// stamp-sim BEFORE import (the build stamp reads MACRO.VERSION) — without it
// the gate checks pass vacuously on the bare-stamp false arm.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  ctxForecastEnabled,
  estimateTurnsToCompact,
  noteCtxTurnBoundary,
  recordCtxSample,
  resetCtxForecastForTest,
} from '../../src/utils/cockpit/ctxForecast.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// 1) Gate: default-ON; =0 opts out; bare-stamp stays OFF (otherwise unaffected).
const saved = process.env.MERCURY_CTX_FORECAST
delete process.env.MERCURY_CTX_FORECAST
t('unset ⇒ ENABLED (default-ON graduation)', ctxForecastEnabled())
process.env.MERCURY_CTX_FORECAST = '0'
t('flag =0 ⇒ disabled (opt-out preserved)', !ctxForecastEnabled())
delete process.env.MERCURY_CTX_FORECAST
{
  // the graduated default is stamp-independent.
  const savedMacro = (globalThis as Record<string, unknown>).MACRO
  delete (globalThis as Record<string, unknown>).MACRO
  t('no MACRO + unset ⇒ STILL enabled (stamp-independence)', ctxForecastEnabled())
  ;(globalThis as Record<string, unknown>).MACRO = savedMacro
}
if (saved === undefined) delete process.env.MERCURY_CTX_FORECAST
else process.env.MERCURY_CTX_FORECAST = saved

// 2) Warmup honesty: no samples / one completed turn ⇒ null (never fabricated).
resetCtxForecastForTest()
t('no samples ⇒ null', estimateTurnsToCompact(50, 92) === null)
recordCtxSample(40)
recordCtxSample(44)
noteCtxTurnBoundary() // one completed turn — one observation
t('one turn ⇒ still null', estimateTurnsToCompact(44, 92) === null)

// 3) Steady growth: 4%/TURN from 48% to a 92% threshold ⇒ ceil(44/4)=11.
recordCtxSample(48)
noteCtxTurnBoundary() // second turn (4)
t('steady growth estimate', estimateTurnsToCompact(48, 92) === 11)

// 3b) TURNS, not API rounds: ten model calls inside ONE
// user turn are ONE observation — the estimate must not inflate.
resetCtxForecastForTest()
recordCtxSample(40)
noteCtxTurnBoundary()
for (let round = 1; round <= 10; round++) recordCtxSample(40 + round * 0.4) // 10 rounds, +4 total
noteCtxTurnBoundary() // turn 1 completes: ONE 4-point observation
recordCtxSample(48)
noteCtxTurnBoundary() // turn 2: another 4
t('a 10-round turn is ONE observation (4%/turn ⇒ 11, not ~110)', estimateTurnsToCompact(48, 92) === 11)

// 4) At/over the threshold ⇒ 0 (compaction imminent, not null).
t('over threshold ⇒ 0', estimateTurnsToCompact(93, 92) === 0)

// 5) Compaction drop resets history (post-compaction rate differs) — detected
// LIVE mid-turn, before any boundary.
recordCtxSample(20) // -28 ⇒ reset
t('compaction drop resets', estimateTurnsToCompact(20, 92) === null)

// 6) Repaint jitter (<0.1 across a whole turn) is not a growth step.
resetCtxForecastForTest()
recordCtxSample(50)
noteCtxTurnBoundary()
recordCtxSample(50.05)
recordCtxSample(50.09)
noteCtxTurnBoundary()
t('jitter ignored', estimateTurnsToCompact(50.09, 92) === null)

// 6b) An idle boundary (no samples between) records nothing.
resetCtxForecastForTest()
recordCtxSample(50)
noteCtxTurnBoundary()
noteCtxTurnBoundary()
noteCtxTurnBoundary()
t('idle boundaries record nothing', estimateTurnsToCompact(50, 92) === null)

// 7) Unknown threshold ⇒ null (autocompact off).
resetCtxForecastForTest()
recordCtxSample(40)
noteCtxTurnBoundary()
recordCtxSample(44)
noteCtxTurnBoundary()
recordCtxSample(48)
noteCtxTurnBoundary()
t('null threshold ⇒ null', estimateTurnsToCompact(48, null) === null)

console.log(fail ? '❌ CTX-FORECAST RED' : '✅ CTX-FORECAST GREEN')
process.exit(fail)
