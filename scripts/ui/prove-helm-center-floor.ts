#!/usr/bin/env bun
import {
  HELM_BOTH_RAILS_MIN,
  HELM_CENTER_FLOOR,
  HELM_RAIL_SLIM,
  HELM_RAIL_W,
  HELM_RAIL_WIDE,
  helmCenterCols,
  railPlan,
} from '../../src/screen/fullscreen-layout/helmGeometry.js'
import {
  nextHelmPane,
  setHelmVitalsAvailable,
} from '../../src/screen/cockpit/helmFocus.js'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

let floorHolds = true
let tierMonotone = true
let vitalsTierExact = true
let slimTierExact = true
let wideTierExact = true
let widthsSum = true
let delegationExact = true
let prevCenter = 0
let prevVitals: boolean | null = null
let firstBoth = -1
const centerPin = HELM_BOTH_RAILS_MIN - 2 - 2 * HELM_RAIL_W
for (let c = 100; c <= 260; c++) {
  const p = railPlan(c)
  if (p.centerCols < HELM_CENTER_FLOOR) floorHolds = false
  if (prevVitals === p.vitals && p.centerCols < prevCenter) tierMonotone = false
  prevCenter = p.centerCols
  prevVitals = p.vitals
  const expectBoth = c >= HELM_BOTH_RAILS_MIN && c - 2 * HELM_RAIL_W - 2 >= HELM_CENTER_FLOOR
  if (p.vitals !== expectBoth) vitalsTierExact = false
  if (expectBoth && firstBoth < 0) firstBoth = c
  if (expectBoth) {
    const railTotal = Math.max(2 * HELM_RAIL_W, Math.min(2 * HELM_RAIL_WIDE, c - 2 - centerPin))
    const expLanes = Math.ceil(railTotal / 2)
    if (p.lanesW !== expLanes || p.vitalsW !== railTotal - expLanes) wideTierExact = false
    if (p.railW !== expLanes) wideTierExact = false
    if (p.lanesW < HELM_RAIL_W || p.lanesW > HELM_RAIL_WIDE) wideTierExact = false
    if (p.vitalsW < HELM_RAIL_W || p.vitalsW > HELM_RAIL_WIDE) wideTierExact = false
    if (p.centerCols < centerPin) wideTierExact = false
    if (p.lanesW + p.vitalsW + 2 + p.centerCols !== c) widthsSum = false
  } else {
    const expectRailW = Math.max(HELM_RAIL_SLIM, Math.min(HELM_RAIL_W, c - 2 - HELM_CENTER_FLOOR))
    if (p.railW !== expectRailW || p.lanesW !== expectRailW) slimTierExact = false
  }
  if (!p.lanes) floorHolds = false
  if (helmCenterCols(c) !== p.centerCols) delegationExact = false
}
check(`center ≥ ${HELM_CENTER_FLOOR} at EVERY cockpit width (100–260)`, floorHolds, '', 'fix railPlan in src/screen/fullscreen-layout/helmGeometry.ts so centerCols never drops below HELM_CENTER_FLOOR and lanes stays true for widths 100 to 260')
check('centerCols is monotone non-decreasing WITHIN each tier', tierMonotone, '', 'fix railPlan in src/screen/fullscreen-layout/helmGeometry.ts so centerCols never shrinks as columns grow inside one tier (vitals on or off)')
check(`both rails return exactly at the ratified ≥${HELM_BOTH_RAILS_MIN}`, vitalsTierExact, `first both-rails width = ${firstBoth}`, 'fix railPlan in src/screen/fullscreen-layout/helmGeometry.ts so vitals is true exactly when columns >= HELM_BOTH_RAILS_MIN and the center still holds HELM_CENTER_FLOOR')
check('single-rail width grows 20→24 continuously (no tier micro-flip)', slimTierExact, '', 'fix the single-rail branch of railPlan in src/screen/fullscreen-layout/helmGeometry.ts so railW and lanesW equal max(HELM_RAIL_SLIM, min(HELM_RAIL_W, columns - 2 - HELM_CENTER_FLOOR))')
check(`wide zone: rails grow ${HELM_RAIL_W}→${HELM_RAIL_WIDE} (lanes takes the odd col) while center holds ≥${centerPin}`, wideTierExact, '', 'fix the both-rails branch of railPlan in src/screen/fullscreen-layout/helmGeometry.ts so lanesW and vitalsW split the rail total with lanes taking the odd column, each between HELM_RAIL_W and HELM_RAIL_WIDE, with center at least the pin')
check('wide zone: lanes + vitals + gutter + center === columns exactly', widthsSum, '', 'fix the both-rails branch of railPlan in src/screen/fullscreen-layout/helmGeometry.ts so lanesW + vitalsW + 2 + centerCols equals columns')
check('helmCenterCols delegates to the plan (modal sizing agrees with rails)', delegationExact, '', 'make helmCenterCols in src/screen/fullscreen-layout/helmGeometry.ts return railPlan(columns).centerCols')

setHelmVitalsAvailable(true)
check("plan w/ vitals: Tab cycles lanes → vitals", nextHelmPane('lanes') === 'vitals', '', 'fix nextHelmPane in src/screen/cockpit/helmFocus.ts so lanes goes to vitals while setHelmVitalsAvailable(true) is set')
setHelmVitalsAvailable(false)
check('plan w/o vitals: Tab cycles lanes → prompt (skips the unmounted rail)', nextHelmPane('lanes') === 'prompt', '', 'fix nextHelmPane in src/screen/cockpit/helmFocus.ts so lanes goes to prompt while setHelmVitalsAvailable(false) is set')
check('prompt still enters lanes first either way', nextHelmPane('prompt') === 'lanes', '', 'fix nextHelmPane in src/screen/cockpit/helmFocus.ts so prompt always goes to lanes')
setHelmVitalsAvailable(true)

console.log(failures === 0 ? '✅ helm center-floor GREEN' : `❌ helm center-floor RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
