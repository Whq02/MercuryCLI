#!/usr/bin/env bun
// ============================================================================
//  prove-switchboard-geometry — the switchboard band-tiling laws (audited,
//  ideology law 5: the pin is the MECHANISM — band arithmetic — never a
//  pixel count).
//
//  switchboardGeometry is THE one geometry owner: paint, the wheel router
//  and the composers all read its numbers, so a band that lies breaks
//  every consumer at once. The audited classes pinned here:
//   · stacked tail-band inversion (GEO-concourse-tail-band-inverted-25rows):
//     the tall band invented rows past the main band — bands must TILE
//     mainRows exactly, no negative heights, every band inside main;
//   · the phantom rail reserve (PAINT-dead-rail-row-when-no-obligations):
//     zero obligations must budget ZERO rail rows (paint renders nothing);
//   · the vertical ledger (DEGRADED-concourse-header-scrolled-off's
//     arithmetic half): header + rail + main + status + help must equal
//     the terminal rows exactly whenever the main floor is not clamping;
//   · THE TWO COMPOSERS (L17 item 1 — the full-width strip retired): the
//     LIVE composer is a budgeted band at the live pane's foot — present
//     exactly when asked and affordable (wide: 4..6 rows shedding to 0;
//     stacked: 4 rows under a MIRROR-owned tall band only), always inside
//     the main band, never under a zero ask (the reduced stage), and the
//     right column tiles list + mirror + composer exactly;
//   · G2 RESIZE SOUNDNESS: every size derives independently — growing
//     100x30 → 250x60 and back lands byte-identical geometry (no state,
//     no hysteresis; the pure function IS the proof of re-derivation).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { switchboardGeometry, resolveConcourseProfile } from '../../src/components/concourse/ConcourseLayout.js'
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
              if (resolveConcourseProfile(cols, rows) === 'too-small') continue
              checks += 1
              const id = `${cols}x${rows} ny=${needsYou} s=${sessions} g=${groups} live=${liveAsk} tall=${tallOwner}`
              const geo = switchboardGeometry(cols, rows, needsYou, sessions, groups, liveAsk, tallOwner)
              const listRows = geo.listBand[1] - geo.listBand[0] + 1
              const mirrorRows = geo.mirrorBand[1] - geo.mirrorBand[0] + 1
              const coordRows = geo.coordBand[1] - geo.coordBand[0] + 1
              const composerRows = geo.liveComposerRows
              const mainTop = geo.mainBand[0]
              const mainEnd = geo.mainBand[1]

              // ── the vertical ledger (the strip band retired whole) ──────
              if (mainTop !== geo.headerRows + geo.railRows + 1)
                fail(id, `mainTop ${mainTop} ≠ header ${geo.headerRows} + rail ${geo.railRows} + 1`)
              if (mainEnd !== mainTop + geo.mainRows - 1) fail(id, `mainBand end ${mainEnd} vs mainRows ${geo.mainRows}`)
              if (geo.statusTop !== mainTop + geo.mainRows) fail(id, `statusTop ${geo.statusTop} ≠ main end + 1`)
              if (geo.helpTop !== geo.statusTop + 3) fail(id, `helpTop ${geo.helpTop} ≠ statusTop+3`)
              const total = geo.headerRows + geo.railRows + geo.mainRows + 3 + 1
              if (total < rows) fail(id, `total ${total} < rows ${rows} (underfull column)`)
              if (geo.mainRows === rows - (geo.headerRows + geo.railRows + 4) && total !== rows)
                fail(id, `unclamped total ${total} ≠ rows ${rows}`)

              // ── the rail budget speaks the paint's truth ────────────────
              if (needsYou === 0 && geo.railRows !== 0) fail(id, `zero obligations budget ${geo.railRows} rail rows`)
              if (needsYou > 0 && geo.railRows !== 3 + geo.railRuleRows + geo.railWindowRows)
                fail(id, `railRows ${geo.railRows} ≠ 3+rule+window`)

              // ── the live composer band (the two-composers law) ──────────
              if (liveAsk === 0 && composerRows !== 0) fail(id, `a zero ask budgeted ${composerRows} composer rows`)
              if (composerRows !== 0 && (composerRows < 4 || composerRows > 6))
                fail(id, `composer band ${composerRows} outside 4..6`)
              if (geo.profile !== 'wide' && composerRows !== 0 && composerRows !== 4)
                fail(id, `stacked composer band ${composerRows} ≠ 4`)
              if (geo.profile !== 'wide' && tallOwner === 'coordinator' && composerRows !== 0)
                fail(id, `coordinator-owned tall band budgeted a live composer (${composerRows})`)
              if (composerRows > 0) {
                const band = geo.liveComposerBand
                if (band[1] - band[0] + 1 !== composerRows) fail(id, `composer band span ≠ liveComposerRows`)
                if (band[0] < mainTop || band[1] > mainEnd) fail(id, `composer band outside main`)
              }

              // ── band tiling inside main ─────────────────────────────────
              if (listRows < 1) fail(id, `list band inverted (${geo.listBand[0]}..${geo.listBand[1]})`)
              if (geo.profile === 'wide') {
                if (listRows + mirrorRows + composerRows !== geo.mainRows)
                  fail(id, `wide tiling list ${listRows} + mirror ${mirrorRows} + composer ${composerRows} ≠ main ${geo.mainRows}`)
                if (coordRows !== geo.mainRows) fail(id, `wide coord ${coordRows} ≠ main ${geo.mainRows}`)
                if (listRows < 5) fail(id, `wide list husk (${listRows} rows)`)
                if (mirrorRows < 1) fail(id, `wide mirror crushed (${mirrorRows} rows)`)
                if (composerRows > 0 && geo.liveComposerBand[1] !== mainEnd)
                  fail(id, `wide composer band does not end the column`)
              } else {
                const tallRows = tallOwner === 'mirror' ? mirrorRows : coordRows
                const tailRows = tallOwner === 'mirror' ? coordRows : mirrorRows
                if (tallRows < 1) fail(id, `tall band empty/inverted (${tallRows})`)
                if (tailRows < 0) fail(id, `tail band negative (${tailRows})`)
                if (listRows + tallRows + Math.max(0, tailRows) + composerRows !== geo.mainRows)
                  fail(
                    id,
                    `stacked tiling list ${listRows} + tall ${tallRows} + tail ${Math.max(0, tailRows)} + composer ${composerRows} ≠ main ${geo.mainRows}`,
                  )
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
  cases.push(String(cols))
}

// ── G2 (resize soundness): grow-and-return derives byte-identical bands ────
for (const [a, b] of [
  [[100, 30], [250, 60]],
  [[120, 40], [80, 24]],
  [[140, 50], [100, 30]],
] as const) {
  checks += 1
  const at = (wh: readonly [number, number]): string =>
    JSON.stringify(switchboardGeometry(wh[0], wh[1], 2, 6, 3, 1, 'mirror', 0))
  const before = at(a)
  at(b) // the resize
  const after = at(a) // and back
  if (before !== after) fail(`resize ${a.join('x')}→${b.join('x')}→back`, 'geometry not re-derived identically')
}

// ── the draftWindow owner: band never exceeds its budget (window ≥ 1) ──────
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

// ── the granted-rows channel (the CB-04 arithmetic) ──────────
//  The peek/older grant is a BUDGET, not a promise: it may lawfully answer 0
//  (the wide profile at its own minimum height grants 0 even with no draft)
//  and the SCREEN owns the refusal (prove-never-stranded-input pins that
//  wiring). Here: the grant is never negative, never exceeds the ask, and
//  the 0-grant hazard the screen guards against EXISTS at the wide minimum
//  (if a future re-tiling grants rows there, the screen guard goes moot and
//  this leg says so).
{
  for (const ask of [2, 4, 8]) {
    for (const cols of [80, 100, 120, 140, 200]) {
      for (const rows of [24, 30, 40]) {
        if (resolveConcourseProfile(cols, rows) === 'too-small') continue
        checks += 1
        const g = switchboardGeometry(cols, rows, 1, 6, 2, 0, 'mirror', ask)
        if (g.peekRows < 0) fail(`grant ${cols}x${rows} ask=${ask}`, 'negative grant')
        if (g.peekRows > ask) fail(`grant ${cols}x${rows} ask=${ask}`, `grant ${g.peekRows} exceeds the ask`)
      }
    }
  }
  checks += 1
  const atWideMin = switchboardGeometry(120, 24, 1, 6, 2, 0, 'mirror', 8)
  if (atWideMin.peekRows !== 0)
    fail('the 0-grant hazard at the wide minimum', `expected 0 at 120x24 (the screen-guard rationale), got ${atWideMin.peekRows} — re-read the A2 screen guard before relaxing this`)
}

if (failures === 0) {
  console.log(`  ✅ switchboard geometry laws hold (${checks} cases, cols ${cases.join('/')})`)
  console.log('PASS prove-switchboard-geometry')
} else {
  console.log(`FAIL prove-switchboard-geometry (${failures} failures / ${checks} cases)`)
  process.exit(1)
}
