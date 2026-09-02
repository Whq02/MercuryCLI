#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-rail-hysteresis.ts — the 149↔150 rail-tier latch
//
//
//  The bug class: railPlan flipped the second rail purely on width, so a
//  window dragged across the 149↔150 boundary remounted the telemetry rail
//  and rewrapped the transcript center 123↔100 on every 1-col wobble.
//
//  Contract: ENGAGE at ≥ HELM_BOTH_RAILS_MIN (150), HOLD while ≥
//  HELM_BOTH_RAILS_RELEASE (144), release below it — one stateful owner
//  (the railPlan latch), pure geometry (railPlanAt) underneath. The engaged
//  band 144–149 keeps the center ≥ the 78 floor and rises continuously into
//  the ≥150 pin.
// ============================================================================
import {
  HELM_BOTH_RAILS_MIN,
  HELM_BOTH_RAILS_RELEASE,
  HELM_CENTER_FLOOR,
  railPlan,
  railPlanAt,
  resetRailTier,
} from '../../src/utils/helmGeometry.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── the audit's oscillation sequence: one tier entry, no thrash ──────────────
resetRailTier()
const seq = [149, 150, 149, 150, 149].map(c => railPlan(c).telemetry)
check(
  'sequence 149,150,149,150,149 → one engage, zero disengage (no thrash)',
  seq.join(',') === 'false,true,true,true,true',
  seq.join(','),
)
const centerHeld = railPlan(149).centerCols
check(
  `engaged 149 keeps the center ≥ ${HELM_CENTER_FLOOR} floor`,
  centerHeld >= HELM_CENTER_FLOOR,
  `center=${centerHeld}`,
)

// ── release edge: below 144 the rail leaves ONCE ─────────────────────────────
check('holds at the release width itself (144 engaged)', railPlan(HELM_BOTH_RAILS_RELEASE).telemetry === true)
check('releases below it (143 → single rail)', railPlan(HELM_BOTH_RAILS_RELEASE - 1).telemetry === false)
check('stays released on the way back up through the band (147)', railPlan(147).telemetry === false)
check(`re-engages only at ${HELM_BOTH_RAILS_MIN}`, railPlan(HELM_BOTH_RAILS_MIN).telemetry === true)

// ── the engaged band is continuous into the ≥150 pin ─────────────────────────
resetRailTier()
railPlan(150) // engage
let bandMonotone = true
let prev = -1
for (let c = HELM_BOTH_RAILS_RELEASE; c <= 155; c++) {
  const p = railPlan(c)
  if (!p.telemetry) bandMonotone = false
  if (p.centerCols < prev) bandMonotone = false
  if (p.centerCols < HELM_CENTER_FLOOR) bandMonotone = false
  prev = p.centerCols
}
check('engaged band 144→155: telemetry stays, center monotone ≥ floor', bandMonotone)

// ── pure core: both states at the same width, floor everywhere ───────────────
let pureHolds = true
for (let c = 100; c <= 260; c++) {
  for (const engaged of [false, true]) {
    const p = railPlanAt(c, engaged)
    if (p.centerCols < HELM_CENTER_FLOOR) pureHolds = false
    if (!p.lanes) pureHolds = false
  }
}
check('railPlanAt: center ≥ floor + lanes present in BOTH latch states (100–260)', pureHolds)
check(
  'pure fn is history-free (same inputs, same plan)',
  JSON.stringify(railPlanAt(149, true)) === JSON.stringify(railPlanAt(149, true)) &&
    railPlanAt(149, false).telemetry === false &&
    railPlanAt(149, true).telemetry === true,
)

// ── audit widths sanity (the acceptance matrix's list) ───────────────────────
resetRailTier()
let sane = true
for (const c of [100, 103, 104, 144, 149, 150, 160, 300]) {
  const p = railPlan(c)
  if (p.centerCols < HELM_CENTER_FLOOR || p.centerCols + 2 > c) sane = false
}
check('center width valid at 100/103/104/144/149/150/160/300', sane)

resetRailTier() // leave the module latch at boot state for same-process readers
console.log(failures === 0 ? '✅ rail hysteresis GREEN' : `❌ rail hysteresis RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
