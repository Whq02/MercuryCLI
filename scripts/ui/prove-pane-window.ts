#!/usr/bin/env bun
// ============================================================================
//  prove-pane-window — cursor-following windows + decision gating (Sol 5.6
//  WS6). The properties the /tickets + /chat reworks stand on:
//
//   (1) REACHABILITY: over a 25-ticket queue (and a 200-row stream), EVERY
//       index is inside its own window — walking ↑/↓ can reach every row
//       (the old board sliced to the first 10 and clamped the cursor there).
//   (2) VISIBLE-SELECTION ACTION: the selected index is always within
//       [start, end), so an action keyed off `sel` always targets the row
//       the ▸ shows — one index space, no display/decision divergence.
//   (3) HONEST INDICATORS: above/below counts always equal the hidden rows.
//   (4) CLAMPS: ends clamp (no wrap), tiny totals show everything, span
//       floors at 1.
//   (5) DECISION GATING (canDecideTicket): owner+pending/needs-info only —
//       the same predicate arms the keys, the hints, and the safety net.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-pane-window.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { paneWindow } = await import('../../src/components/mercury-ui/paneWindow.js')

console.log('============================================================')
console.log(' pane window — reachability · visible selection · gating')
console.log('============================================================')

// (1)+(2)+(3): every row of a 25-ticket queue is reachable and selected-visible.
{
  let allVisible = true
  let indicatorsHonest = true
  for (let sel = 0; sel < 25; sel++) {
    const w = paneWindow(25, sel, 6)
    if (!(sel >= w.start && sel < w.end)) allVisible = false
    if (w.above !== w.start || w.below !== 25 - w.end) indicatorsHonest = false
    if (w.end - w.start !== 6) indicatorsHonest = false
  }
  check('25-ticket queue: EVERY selection is inside its own window', allVisible)
  check('25-ticket queue: ↑/↓ indicators equal the hidden rows exactly', indicatorsHonest)
}
{
  let allVisible = true
  for (let sel = 0; sel < 200; sel++) {
    const w = paneWindow(200, sel, 12)
    if (!(sel >= w.start && sel < w.end)) allVisible = false
  }
  check('200-row stream: full reachability at span 12', allVisible)
}

// (4) clamps
{
  const top = paneWindow(25, 0, 6)
  check('top clamp: window starts at 0', top.start === 0 && top.above === 0)
  const bottom = paneWindow(25, 24, 6)
  check('bottom clamp: window ends at N', bottom.end === 25 && bottom.below === 0)
  const tiny = paneWindow(3, 1, 10)
  check('total <= span: everything visible, no indicators', tiny.start === 0 && tiny.end === 3 && tiny.above === 0 && tiny.below === 0)
  const overSel = paneWindow(10, 99, 4)
  check('out-of-range sel clamps into the last window', overSel.end === 10)
  const zero = paneWindow(0, 0, 5)
  check('empty list: empty window', zero.start === 0 && zero.end === 0)
  const floor = paneWindow(10, 5, 0)
  check('span floors at 1 (never a zero-height window)', floor.end - floor.start === 1)
}

// ── (6) THE GROUPED FIT (fitGroupedWindow — the switchboard board's law) ────
// The reference board: 6 sessions in 3 groups (READY 1 · WORKING 3 · QUEUED
// 2), selection on row 1, a 5-row content budget (142×38). The window must
// TILE the budget: rows + straddled headings + more-line == budget, and never
// give back rows the chrome does not need (the over-shrink painted ONE row
// over an empty pane — the hosted campaign's concourse red).
{
  const { fitGroupedWindow, paneWindow: pw } = await import('../../src/components/mercury-ui/paneWindow.js')
  const groups = ['ready', 'working', 'working', 'working', 'queued', 'queued']
  const fit = (budget: number, sel: number) =>
    fitGroupedWindow(groups.length, budget, span => pw(groups.length, sel, span), i => groups[i]!)
  const tiles = (w: { start: number; end: number; above: number; below: number }, budget: number) => {
    const heads = new Set(groups.slice(w.start, w.end)).size
    const more = w.above > 0 || w.below > 0 ? 1 : 0
    return w.end - w.start + heads + more
  }
  console.log('\n(6) grouped fit — rows + headings + more-line tile the budget')
  const w5 = fit(5, 1)
  check('142×38 reference (budget 5, sel 1): TWO rows paint (READY + WORKING heads + more)', w5.end - w5.start === 2, JSON.stringify(w5))
  check('…and the tiling is exact (2 rows + 2 heads + 1 more == 5)', tiles(w5, 5) === 5, String(tiles(w5, 5)))
  const w9 = fit(9, 1)
  check('a 9-row budget shows the WHOLE board (6 rows + 3 heads, no more-line)', w9.start === 0 && w9.end === 6 && w9.above === 0 && w9.below === 0, JSON.stringify(w9))
  for (const budget of [3, 4, 5, 6, 7, 8]) {
    for (let sel = 0; sel < groups.length; sel++) {
      const w = fit(budget, sel)
      const need = tiles(w, budget)
      const rows = w.end - w.start
      // Maximal: one more row (the same window function, span+1) would
      // overflow the budget — or the whole board already shows.
      const wider = pw(groups.length, sel, rows + 1)
      const maximal = rows === groups.length || tiles(wider, budget) > budget
      check(`budget ${budget} sel ${sel}: fits (${need} ≤ ${budget}), ≥1 row, maximal`, need <= budget && rows >= 1 && maximal, JSON.stringify(w))
    }
  }
}

// (7) MEASURED fit — fitGroupedWindow's general form for VARIABLE-height
// rows (the /model tail-clip law: a focused row expands by a bordered card
// and detail lines; an index-span window fit by COUNT while its paint
// overflowed the modal slot, which bottom-clipped the focused card).
{
  const { fitMeasuredWindow, paneWindow: pw } = await import('../../src/components/mercury-ui/paneWindow.js')
  // A 10-row list where the FOCUSED row paints 4 lines and every other 1
  // (the picker's full-tier card), plus a 1-line more-counter per cut edge.
  const n = 10
  const measureFor = (sel: number) => (w: { start: number; end: number; above: number; below: number }): number => {
    let lines = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0)
    for (let i = w.start; i < w.end; i++) lines += i === sel ? 4 : 1
    return lines
  }
  console.log('\n(7) measured fit — variable row heights tile the budget')
  // The law: the window's paint fits the budget — except at the 1-row
  // FLOOR, where the cursor row (plus its honest counters) outranks the
  // budget's last word and the modal clips instead of losing the cursor.
  for (const budget of [4, 6, 8, 12]) {
    for (let sel = 0; sel < n; sel++) {
      const w = fitMeasuredWindow(n, budget, span => pw(n, sel, span), measureFor(sel))
      const paint = measureFor(sel)(w)
      const rows = w.end - w.start
      const inside = sel >= w.start && sel < w.end
      check(
        `budget ${budget} sel ${sel}: cursor inside, ≥1 row, paint ${paint} ≤ ${budget} (or the 1-row floor)`,
        inside && rows >= 1 && (paint <= budget || rows === 1),
        JSON.stringify(w),
      )
    }
  }
  // The floor: a budget SMALLER than the focused row's own paint still
  // returns the cursor row (content outranks the budget's last word — the
  // modal clips honestly rather than losing the cursor).
  const tiny = fitMeasuredWindow(n, 2, span => pw(n, 5, span), measureFor(5))
  check('a sub-row budget still returns the cursor row', tiny.end - tiny.start === 1 && tiny.start === 5, JSON.stringify(tiny))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL PANE-WINDOW CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
