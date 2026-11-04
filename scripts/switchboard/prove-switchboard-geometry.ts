#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { COORDINATOR_REST_ROWS, MANAGER_MIN_COLS, REDUCED_NOTICE_ROWS, switchboardGeometry, resolveConcourseProfile } from '../../src/components/concourse/ConcourseLayout.js'
import { RAIL_MAX_ROWS } from '../../src/components/concourse/NeedsYouRail.js'
import { draftWindow } from '../../src/components/concourse/lineDraft.js'

let failures = 0
let checks = 0
function fail(label: string, detail: string): void {
  failures += 1
  if (failures <= 25) console.log(`  ❌ ${label} — ${detail}`)
}

const cases: string[] = []
for (const cols of [80, 100, 119, 120, 140, 200, 250]) {
  for (let rows = 24; rows <= 60; rows += 1) {
    for (const needsYou of [0, 1, 2, 3, 6]) {
      for (const sessions of [0, 1, 6, 12]) {
        for (const groups of [1, 3, 4]) {
          for (const liveAsk of [0, 1, 2, 3]) {
            for (const tallOwner of ['mirror', 'coordinator'] as const) {
              for (const third of [0, COORDINATOR_REST_ROWS, REDUCED_NOTICE_ROWS]) {
              checks += 1
              const id = `${cols}x${rows} ny=${needsYou} s=${sessions} g=${groups} live=${liveAsk} tall=${tallOwner} third=${third}`
              const geo = switchboardGeometry(cols, rows, needsYou, sessions, groups, liveAsk, tallOwner, 0, 'list', third)
              const listRows = geo.listBand[1] - geo.listBand[0] + 1
              const mirrorRows = geo.mirrorBand[1] - geo.mirrorBand[0] + 1
              const coordRows = geo.coordBand[1] - geo.coordBand[0] + 1
              const composerRows = geo.liveComposerRows
              const mainTop = geo.mainBand[0]
              const mainEnd = geo.mainBand[1]

              if (mainTop !== 1) fail(id, `mainTop ${mainTop} ≠ 1 (nothing paints above the panes)`)
              if (mainEnd !== mainTop + geo.mainRows - 1) fail(id, `mainBand end ${mainEnd} vs mainRows ${geo.mainRows}`)
              if (geo.statusTop !== mainTop + geo.mainRows) fail(id, `statusTop ${geo.statusTop} ≠ main end + 1`)
              if (geo.helpTop !== geo.statusTop + 3) fail(id, `helpTop ${geo.helpTop} ≠ statusTop+3`)
              if (geo.mainRows + 3 + 1 !== rows) fail(id, `main ${geo.mainRows} + status 3 + legend 1 ≠ rows ${rows}`)

              if (needsYou === 0 && geo.railWindowRows !== 0) fail(id, `zero obligations budget ${geo.railWindowRows} ask rows`)
              if (needsYou > 0 && (geo.railWindowRows < 1 || geo.railWindowRows > Math.min(needsYou, RAIL_MAX_ROWS)))
                fail(id, `ask window ${geo.railWindowRows} outside 1..min(asks, ${RAIL_MAX_ROWS})`)
              if (geo.railRows !== 1 + geo.railWindowRows) fail(id, `the NEEDS YOU block ${geo.railRows} ≠ its heading + ${geo.railWindowRows} asks`)

              if (liveAsk === 0 && composerRows !== 0) fail(id, `a zero ask budgeted ${composerRows} composer rows`)
              if (composerRows !== 0 && (composerRows < 4 || composerRows > 6))
                fail(id, `composer band ${composerRows} outside 4..6`)
              if (composerRows > 0) {
                const band = geo.liveComposerBand
                if (band[1] - band[0] + 1 !== composerRows) fail(id, `composer band span ≠ liveComposerRows`)
                if (band[0] <= geo.mirrorBand[0] || band[1] !== geo.mirrorBand[1] - 1) fail(id, `the message box is not the foot of the live pane (${band.join('..')} in ${geo.mirrorBand.join('..')})`)
              }
              if (mirrorRows - 2 - composerRows < 2) fail(id, `live transcript crushed (${mirrorRows - 2 - composerRows} rows)`)

              if (listRows < 8) fail(id, `manager husk (${listRows} rows)`)
              if (geo.listContentRows < 1) fail(id, `no list row (${geo.listContentRows})`)
              if (geo.listContentRows + geo.peekRows + 6 + geo.railWindowRows > listRows)
                fail(id, `the manager overflows: list ${geo.listContentRows} + peek ${geo.peekRows} + chrome 6 + asks ${geo.railWindowRows} > ${listRows}`)
              if (third === 0 && coordRows !== 0) fail(id, `no third pane, yet ${coordRows} coordinator rows`)
              if (third > 0 && tallOwner === 'mirror' && coordRows !== third) fail(id, `the resting third pane is ${coordRows}, not ${third}`)
              if (third > 0 && tallOwner === 'coordinator' && coordRows < third) fail(id, `the focused third pane shrank to ${coordRows}`)
              if (geo.profile === 'wide') {
                if (cols < 100) fail(id, 'two panes under 100 columns')
                if (geo.mirrorBand[0] !== mainTop || geo.mirrorBand[1] !== mainEnd) fail(id, `the live view is not the full column (${geo.mirrorBand.join('..')})`)
                if (geo.listBand[0] !== mainTop || listRows + coordRows !== geo.mainRows)
                  fail(id, `right column tiling list ${listRows} + coordinator ${coordRows} ≠ main ${geo.mainRows}`)
                if (coordRows > 0 && geo.coordBand[0] !== geo.listBand[1] + 1) fail(id, 'the third pane is not under the manager')
                if (geo.liveCols[0] !== 3 || geo.rightCols[0] !== geo.liveCols[1] + 2 || geo.rightCols[1] !== 2 + geo.interior)
                  fail(id, `columns ${geo.liveCols.join('..')} | ${geo.rightCols.join('..')} do not tile the interior ${geo.interior}`)
                if (geo.rightCols[1] - geo.rightCols[0] + 1 < MANAGER_MIN_COLS) fail(id, 'the manager under its floor width')
                if (geo.liveCols[1] - geo.liveCols[0] + 1 <= geo.rightCols[1] - geo.rightCols[0] + 1) fail(id, 'the live view is not the wider pane')
              } else {
                if (cols >= 100) fail(id, 'stacked at 100 columns or more')
                if (geo.mirrorBand[0] !== mainTop || geo.listBand[0] !== geo.mirrorBand[1] + 1)
                  fail(id, `stacked order live ${geo.mirrorBand.join('..')} then manager ${geo.listBand.join('..')}`)
                if (mirrorRows + listRows + coordRows !== geo.mainRows)
                  fail(id, `stacked tiling live ${mirrorRows} + manager ${listRows} + coordinator ${coordRows} ≠ main ${geo.mainRows}`)
                if (coordRows > 0 && geo.coordBand[0] !== geo.listBand[1] + 1) fail(id, 'the third pane is not under the manager')
                if (mirrorRows < 6) fail(id, `stacked live view under its floor (${mirrorRows})`)
              }
              if (failures > 25) {
                console.log(`  … stopping after 25 failures (${checks} cases so far)`)
                console.log('FAIL prove-switchboard-geometry')
                process.exit(1)
              }
              }
            }
          }
        }
      }
    }
  }
  cases.push(String(cols))
}

for (const [a, b] of [
  [[100, 30], [250, 60]],
  [[120, 40], [80, 24]],
  [[140, 50], [100, 30]],
] as const) {
  checks += 1
  const at = (wh: readonly [number, number]): string =>
    JSON.stringify(switchboardGeometry(wh[0], wh[1], 2, 6, 3, 1, 'mirror', 0))
  const before = at(a)
  at(b)
  const after = at(a)
  if (before !== after) fail(`resize ${a.join('x')}→${b.join('x')}→back`, 'geometry not re-derived identically')
}

for (let lines = 1; lines <= 8; lines += 1) {
  const text = Array.from({ length: lines }, (_, i) => `line${i}`).join(String.fromCharCode(10))
  for (let caret = 0; caret <= text.length; caret += 3) {
    for (let budget = 1; budget <= 5; budget += 1) {
      checks += 1
      const w = draftWindow({ text, caret }, budget)
      const indicators = (w.hiddenAbove > 0 ? 1 : 0) + (w.hiddenBelow > 0 ? 1 : 0)
      if (w.bandRows !== w.windowRows + indicators) fail(`draftWindow l=${lines} c=${caret} b=${budget}`, 'bandRows ledger')
      if (w.windowRows < 1) fail(`draftWindow l=${lines} c=${caret} b=${budget}`, 'window under 1')
      if (w.windowRows > 1 && w.bandRows > budget)
        fail(`draftWindow l=${lines} c=${caret} b=${budget}`, `band ${w.bandRows} over budget ${budget} with window ${w.windowRows}`)
      if (w.hiddenAbove + w.windowRows + w.hiddenBelow !== lines)
        fail(`draftWindow l=${lines} c=${caret} b=${budget}`, 'rows do not partition the draft')
    }
  }
}

{
  for (const ask of [2, 4, 8]) {
    for (const cols of [80, 100, 120, 140, 200]) {
      for (const rows of [24, 30, 40]) {
        checks += 1
        const g = switchboardGeometry(cols, rows, 1, 6, 2, 0, 'mirror', ask)
        if (g.peekRows < 0) fail(`grant ${cols}x${rows} ask=${ask}`, 'negative grant')
        if (g.peekRows > ask) fail(`grant ${cols}x${rows} ask=${ask}`, `grant ${g.peekRows} exceeds the ask`)
      }
    }
  }
  checks += 1
  const atStackedMin = switchboardGeometry(80, 22, 3, 6, 2, 0, 'mirror', 8)
  if (atStackedMin.peekRows !== 0)
    fail('the 0-grant hazard at the stacked minimum', `expected 0 at 80x22 with a full ask block (the screen-guard rationale), got ${atStackedMin.peekRows} — re-read the A2 screen guard before relaxing this`)
  checks += 1
  const atWideMin = switchboardGeometry(120, 24, 3, 6, 2, 0, 'mirror', 8)
  if (atWideMin.peekRows < 2)
    fail('the full-height manager grants the older-chats drop-down at the wide minimum', `got ${atWideMin.peekRows} at 120x24 with a full ask block`)}

if (failures === 0) {
  console.log(`  ✅ switchboard geometry laws hold (${checks} cases, cols ${cases.join('/')})`)
  console.log('PASS prove-switchboard-geometry')
} else {
  console.log(`FAIL prove-switchboard-geometry (${failures} failures / ${checks} cases)`)
  process.exit(1)
}
