#!/usr/bin/env bun
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

let floorHolds = true
let tierMonotone = true
let telemetryTierExact = true
let slimTierExact = true
let wideTierExact = true
let widthsSum = true
let delegationExact = true
let prevCenter = 0
let prevTelemetry: boolean | null = null
let firstBoth = -1
const centerPin = HELM_BOTH_RAILS_MIN - 2 - 2 * HELM_RAIL_W
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
    const railTotal = Math.max(2 * HELM_RAIL_W, Math.min(2 * HELM_RAIL_WIDE, c - 2 - centerPin))
    const expLanes = Math.ceil(railTotal / 2)
    if (p.lanesW !== expLanes || p.telemetryW !== railTotal - expLanes) wideTierExact = false
    if (p.railW !== expLanes) wideTierExact = false
    if (p.lanesW < HELM_RAIL_W || p.lanesW > HELM_RAIL_WIDE) wideTierExact = false
    if (p.telemetryW < HELM_RAIL_W || p.telemetryW > HELM_RAIL_WIDE) wideTierExact = false
    if (p.centerCols < centerPin) wideTierExact = false
    if (p.lanesW + p.telemetryW + 2 + p.centerCols !== c) widthsSum = false
  } else {
    const expectRailW = Math.max(HELM_RAIL_SLIM, Math.min(HELM_RAIL_W, c - 2 - HELM_CENTER_FLOOR))
    if (p.railW !== expectRailW || p.lanesW !== expectRailW) slimTierExact = false
  }
  if (!p.lanes) floorHolds = false
  if (helmCenterCols(c) !== p.centerCols) delegationExact = false
}
check(`center ≥ ${HELM_CENTER_FLOOR} at EVERY cockpit width (100–260)`, floorHolds)
check('centerCols is monotone non-decreasing WITHIN each tier', tierMonotone)
check(`both rails return exactly at the ratified ≥${HELM_BOTH_RAILS_MIN}`, telemetryTierExact, `first both-rails width = ${firstBoth}`)
check('single-rail width grows 20→24 continuously (no tier micro-flip)', slimTierExact)
check(`wide zone: rails grow ${HELM_RAIL_W}→${HELM_RAIL_WIDE} (lanes takes the odd col) while center holds ≥${centerPin}`, wideTierExact)
check('wide zone: lanes + telemetry + gutter + center === columns exactly', widthsSum)
check('helmCenterCols delegates to the plan (modal sizing agrees with rails)', delegationExact)

setHelmTelemetryAvailable(true)
check("plan w/ telemetry: Tab cycles lanes → telemetry", nextHelmPane('lanes') === 'telemetry')
setHelmTelemetryAvailable(false)
check('plan w/o telemetry: Tab cycles lanes → prompt (skips the unmounted rail)', nextHelmPane('lanes') === 'prompt')
check('prompt still enters lanes first either way', nextHelmPane('prompt') === 'lanes')
setHelmTelemetryAvailable(true)

console.log(failures === 0 ? '✅ helm center-floor GREEN' : `❌ helm center-floor RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
