#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-helm-center-floor.ts — the CENTER-FIRST cockpit invariant
// the transcript center column NEVER drops
//  below HELM_CENTER_FLOOR at any cockpit width — rails shed in tiers instead
//  (both ≥150 · one rail below, growing 20→24 continuously so no tier flip
//  ever shrinks the chat), and the Tab focus cycle skips the telemetry pane
//  exactly when the plan folds it (layout and cycle read the SAME decision —
//  they can never disagree). Pure — no PTY, no API; ui suite always-on.
// ============================================================================
import {
  HELM_BOTH_RAILS_MIN,
  HELM_CENTER_FLOOR,
  HELM_RAIL_SLIM,
  HELM_RAIL_W,
  HELM_RAIL_WIDE,
  helmCenterCols,
  railPlan,
} from '../../src/utils/helmGeometry.js'
import {
  nextHelmPane,
  setHelmTelemetryAvailable,
} from '../../src/utils/cockpit/helmFocus.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── the floor + tier table across every cockpit width ───────────────────────
let floorHolds = true
let tierMonotone = true // monotone WITHIN a tier; a tier flip legitimately trades center for a rail
let telemetryTierExact = true
let slimTierExact = true
let wideTierExact = true
let widthsSum = true
let delegationExact = true
let prevCenter = 0
let prevTelemetry: boolean | null = null
let firstBoth = -1
const centerPin = HELM_BOTH_RAILS_MIN - 2 - 2 * HELM_RAIL_W // the both-rails entry center (100)
for (let c = 100; c <= 260; c++) {
  const p = railPlan(c)
  if (p.centerCols < HELM_CENTER_FLOOR) floorHolds = false
  if (prevTelemetry === p.telemetry && p.centerCols < prevCenter) tierMonotone = false
  prevCenter = p.centerCols
  prevTelemetry = p.telemetry
  const expectBoth = c >= HELM_BOTH_RAILS_MIN && c - 2 * HELM_RAIL_W - 2 >= HELM_CENTER_FLOOR
  if (p.telemetry !== expectBoth) telemetryTierExact = false
  if (expectBoth && firstBoth < 0) firstBoth = c
  if (expectBoth) {
    // WIDE zone: rails absorb width first (24→30 each, lanes gets
    // the odd column) while the center holds the entry pin, then the center
    // rises. Per-side widths are exact and bounded; the center never wobbles.
    const railTotal = Math.max(2 * HELM_RAIL_W, Math.min(2 * HELM_RAIL_WIDE, c - 2 - centerPin))
    const expLanes = Math.ceil(railTotal / 2)
    if (p.lanesW !== expLanes || p.telemetryW !== railTotal - expLanes) wideTierExact = false
    if (p.railW !== expLanes) wideTierExact = false
    if (p.lanesW < HELM_RAIL_W || p.lanesW > HELM_RAIL_WIDE) wideTierExact = false
    if (p.telemetryW < HELM_RAIL_W || p.telemetryW > HELM_RAIL_WIDE) wideTierExact = false
    if (p.centerCols < centerPin) wideTierExact = false
    if (p.lanesW + p.telemetryW + 2 + p.centerCols !== c) widthsSum = false
  } else {
    // single-rail zone: railW grows 20→24 with width while center ≥ floor
    const expectRailW = Math.max(HELM_RAIL_SLIM, Math.min(HELM_RAIL_W, c - 2 - HELM_CENTER_FLOOR))
    if (p.railW !== expectRailW || p.lanesW !== expectRailW) slimTierExact = false
  }
  if (!p.lanes) floorHolds = false // lanes rail is the cockpit's identity — never sheds
  if (helmCenterCols(c) !== p.centerCols) delegationExact = false
}
check(`center ≥ ${HELM_CENTER_FLOOR} at EVERY cockpit width (100–260)`, floorHolds)
check('centerCols is monotone non-decreasing WITHIN each tier', tierMonotone)
check(`both rails return exactly at the ratified ≥${HELM_BOTH_RAILS_MIN}`, telemetryTierExact, `first both-rails width = ${firstBoth}`)
check('single-rail width grows 20→24 continuously (no tier micro-flip)', slimTierExact)
check(`wide zone: rails grow ${HELM_RAIL_W}→${HELM_RAIL_WIDE} (lanes takes the odd col) while center holds ≥${centerPin}`, wideTierExact)
check('wide zone: lanes + telemetry + gutter + center === columns exactly', widthsSum)
check('helmCenterCols delegates to the plan (modal sizing agrees with rails)', delegationExact)

// ── the focus cycle honors the plan ─────────────────────────────────────────
setHelmTelemetryAvailable(true)
check("plan w/ telemetry: Tab cycles lanes → telemetry", nextHelmPane('lanes') === 'telemetry')
setHelmTelemetryAvailable(false)
check('plan w/o telemetry: Tab cycles lanes → prompt (skips the unmounted rail)', nextHelmPane('lanes') === 'prompt')
check('prompt still enters lanes first either way', nextHelmPane('prompt') === 'lanes')
setHelmTelemetryAvailable(true) // restore module default for any same-process consumer

console.log(failures === 0 ? '✅ helm center-floor GREEN' : `❌ helm center-floor RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
