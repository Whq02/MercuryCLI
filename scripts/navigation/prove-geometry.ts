#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-geometry.ts — the shared
//  responsive-geometry contracts (mercury-ui/geometry.ts) + their adoption by
//  the REAL surfaces (a helper used by one specimen is not completion — §7).
//
//  Run: ~/.bun/bin/bun run scripts/navigation/prove-geometry.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  frameCells,
  innerWidth,
  packHints,
  panelWidth,
  paneWindow,
  shedToFit,
  viewportRows,
} from '../../src/components/mercury-ui/geometry.js'
import { stringWidth } from '../../src/ink/stringWidth.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.COMPASS_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('== frame + width laws: clamp at zero, never exceed the terminal ==')
check('border+padding frame = 4', frameCells({ border: true, paddingX: 1 }) === 4)
check('borderless frame = padding only', frameCells({ border: false, paddingX: 2 }) === 4)
check('innerWidth clamps at zero', innerWidth(3, { border: true, paddingX: 1 }) === 0)
check('innerWidth normal', innerWidth(80, { border: true, paddingX: 1 }) === 76)
check('panelWidth honors the cap', panelWidth(120, { cap: 62, reserve: 2 }) === 62)
check('panelWidth honors the reserve', panelWidth(50, { cap: 62, reserve: 2 }) === 48)
check('panelWidth floors on narrow screens', panelWidth(18, { cap: 62, reserve: 2, min: 20 }) === 18, String(panelWidth(18, { cap: 62, reserve: 2, min: 20 })))
check('panelWidth NEVER exceeds the terminal', panelWidth(15, { min: 20 }) === 15)
check('panelWidth(0) = 0 (never negative)', panelWidth(0, { min: 20 }) === 0)
// MINI-TEMPER item 4 re-anchor: the old 'clamps at the floor' pin PINNED the
// manufacture (10 rows − 26 reserve ⇒ 4 rows painted into negative space).
// The law now: min is ASPIRATIONAL — never above availability, rows, or cap.
check('viewportRows: zero available = ZERO (min cannot manufacture)', viewportRows(10, { reserve: 26, min: 4 }) === 0)
check('viewportRows: min floors only within availability', viewportRows(13, { reserve: 11, min: 3 }) === 2)
check('viewportRows honors the cap', viewportRows(100, { reserve: 26, cap: 12 }) === 12)
check('viewportRows normal', viewportRows(40, { reserve: 26, min: 4, cap: 12 }) === 12)
{
  // Property sweep: rows 0..60 × reserve {0,4,11,26,32} × min {0,1,3,4} ×
  // cap {2,12,∞} — the result never exceeds rows, post-reserve availability,
  // or the cap; zero available is always zero.
  let bad = 0
  for (let rows = 0; rows <= 60; rows++) {
    for (const reserve of [0, 4, 11, 26, 32]) {
      for (const min of [0, 1, 3, 4]) {
        for (const cap of [2, 12, Number.POSITIVE_INFINITY]) {
          const out = viewportRows(rows, { reserve, min, cap })
          const available = Math.max(0, rows - reserve)
          const ok = out <= rows && out <= available && out <= cap && (available > 0 || out === 0) && out >= 0
          if (!ok) {
            bad++
            if (bad === 1) check(`HEIGHT-LAW break: rows=${rows} reserve=${reserve} min=${min} cap=${cap} → ${out}`, false)
          }
        }
      }
    }
  }
  check('viewportRows height law holds across the sweep (0..60 × reserves × mins × caps)', bad === 0)
}

console.log('== paneWindow: the ONE cursor-following window ==')
{
  const w = paneWindow(100, 50, 10)
  check('selection stays inside the window', w.start <= 50 && 50 < w.end)
  check('overflow counters are honest', w.above === w.start && w.below === 100 - w.end)
  const top = paneWindow(100, 0, 10)
  check('top clamps', top.start === 0)
  const bot = paneWindow(100, 99, 10)
  check('bottom clamps', bot.end === 100)
  const small = paneWindow(3, 1, 10)
  check('short lists never window', small.start === 0 && small.end === 3 && small.above === 0)
}

console.log('== one-line help packing: complete segments, no dangling separator ==')
{
  const segs = ['↵ open', 'x kill', 'r refresh', 'esc close']
  const full = packHints(segs, 200)
  check('wide: everything packs', full === '↵ open · x kill · r refresh · esc close')
  const tight = packHints(segs, 20)
  check('tight: complete segments only', tight === '↵ open · x kill …' || tight === '↵ open · x kill', tight)
  check('never ends with a separator', !/·\s*$/.test(tight))
  for (let b = 1; b <= 60; b++) {
    const s = packHints(segs, b)
    if (stringWidth(s) > b) { check(`budget ${b}: fits`, false, s); break }
    if (/[·]\s*$/.test(s)) { check(`budget ${b}: no dangling separator`, false, s); break }
  }
  check('every budget fits + never dangles (swept 1..60)', true)
  check('zero budget → empty', packHints(segs, 0) === '')
  const noEllipsisRoom = packHints(['abcdef', 'zz'], 6)
  check('ellipsis appears ONLY when it fits', noEllipsisRoom === 'abcdef')
}

console.log('== declared shedding: whole units, lowest priority first ==')
{
  const parts = [
    { text: 'Fixing the login flow', priority: 3 },
    { text: 'waiting for Opus 4.8', priority: 2 },
    { text: 'high', priority: 1 },
    { text: '3.4s', priority: 0 },
  ]
  const wide = shedToFit(parts, 200)
  check('wide keeps everything in display order', wide.map(p => p.text).join(' · ') === 'Fixing the login flow · waiting for Opus 4.8 · high · 3.4s')
  const mid = shedToFit(parts, 50)
  check('mid sheds the LOWEST priority first (elapsed)', !mid.some(p => p.text === '3.4s') && mid.some(p => p.text === 'high') === (stringWidth('Fixing the login flow · waiting for Opus 4.8 · high') <= 50))
  const tiny = shedToFit(parts, 21)
  check('tiny keeps only the primary label', tiny.length === 1 && tiny[0]!.text === 'Fixing the login flow')
  check('secondary yields BEFORE the primary label', shedToFit(parts, 30).some(p => p.priority === 3))
}

console.log('== packFooter: close preferred, physical width ABSOLUTE (MINI-TEMPER 3) ==')
{
  const { packFooter } = await import('../../src/components/mercury-ui/footerHint.js')
  const { stringWidth } = await import('../../src/ink/stringWidth.js')
  const footer = '↑↓ select · ↵/→ view · x kill · tab/1-9 section · esc close'
  check('wide keeps everything', packFooter(footer, 200) === footer)
  const tight = packFooter(footer, 30)
  check('tight RESERVES the close hint', /esc close$/.test(tight), tight)
  check('tight keeps complete leading segments', tight.startsWith('↑↓ select'), tight)

  // THE LAW (re-anchored — the old 'close-only floor' pin PINNED the
  // overflow): stringWidth(output) never exceeds the supplied budget for ANY
  // non-negative budget, across every footer shape; and no output ever ends
  // with a dangling separator. Property sweep 0..120.
  const FOOTERS = [
    footer,
    'esc close',
    'esc / ← close',
    'esc dismiss',
    'esc keep',
    '← back',
    'esc parks the asks — later',
    '↑↓ move · ↵ insert',
    'type · ↑↓ move · ↵ open · esc cancel',
    '漢字メニュー · esc close',
  ]
  let overflows = 0
  let dangles = 0
  for (const f of FOOTERS) {
    for (let b = 0; b <= 120; b++) {
      const out = packFooter(f, b)
      if (stringWidth(out) > b) {
        overflows++
        if (overflows === 1) check(`OVERFLOW: "${f}" @ ${b} → "${out}"`, false)
      }
      if (/·\s*$/.test(out)) {
        dangles++
        if (dangles === 1) check(`DANGLE: "${f}" @ ${b} → "${out}"`, false)
      }
    }
  }
  check('stringWidth(output) ≤ budget for EVERY footer × budget 0..120', overflows === 0)
  check('no output ends with a dangling separator (same sweep)', dangles === 0)

  // The shortest-truthful-close projection ladder.
  check('exact fit keeps the authored close', packFooter('esc close', 9) === 'esc close')
  check("'esc' when 'esc close' cannot fit", packFooter('esc close', 8) === 'esc')
  check('empty when even the bare key cannot fit', packFooter('esc close', 2) === '')
  check('the esc/← pair keeps its authored form at width', packFooter('esc / ← close', 13) === 'esc / ← close')
  check('the esc/← pair projects to the primary key + verb', packFooter('esc / ← close', 12) === 'esc close')
  check('…then to the bare key', packFooter('esc / ← close', 4) === 'esc')
  check('an ←-only close projects to ←', packFooter('← back', 5) === '←')
  check('a DEFER-shaped close keeps its own verb while it fits', packFooter('esc parks the asks — later', 26) === 'esc parks the asks — later' && packFooter('esc parks the asks — later', 10) === 'esc later')
  check('close still preferred over leading segments when narrow', packFooter('↑↓ select · esc close', 9) === 'esc close')
  check('zero budget is empty', packFooter(footer, 0) === '')
}

console.log('== adoption pins: the real surfaces ride the contracts ==')
{
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')
  const flat = read('src/components/mercury-ui/useFlatList.ts')
  const palette = read('src/components/MercuryCommandPalette.tsx')
  const consoleSrc = read('src/commands/console/console.tsx')
  const panes = read('src/components/mercury-ui/NavigablePanes.tsx')
  const picker = read('src/components/MercuryModelPicker.tsx')
  check('useFlatList windows via paneWindow', flat.includes('paneWindow(list.length, absSel, maxRows)'))
  check('palette windows via paneWindow (the counter spends a cap row — LUSTRE L4)', palette.includes('paneWindow(filtered.length, sel, listRows)'))
  check('palette viewport via viewportRows', palette.includes('viewportRows(termRows'))
  check('console windows via paneWindow', consoleSrc.includes('paneWindow(entries.length, sel, LIST_ROWS)'))
  check('NavigablePanes frame via geometry', panes.includes('innerPaneWidth(cols, { border: true, paddingX: 1 })'))
  check('model picker width via panelWidth', picker.includes('panelWidthFor(cols, { cap: 62'))
  check('the inline center/clamp window math is dead in the palette', !palette.includes('sel - Math.floor(rowCap / 2)'))
  check('the inline window math is dead in the console', !consoleSrc.includes('sel - Math.floor(LIST_ROWS / 2)'))
  const shell = read('src/components/mercury-ui/components.tsx')
  check('CommandCenter packs every hosted footer (the §8 chokepoint)', shell.includes('packFooter('))
  check('NavigablePanes packs its footer (complete segments, close reserved — clickable hints only when the WHOLE canonical line fits; the packed fallback carries the hints in their canonical slot)', panes.includes('headText.length + 3 + hintsWidth + footerTailText.length <= budget') && panes.includes('packFooter(fullText, budget)'))

  // MINI-TEMPER items 3+4: the manufactured-cell floors are DEAD.
  check('CommandCenter footer budget floors at ZERO (no manufactured cells)', shell.includes('Math.max(0, cols - 4)') && !shell.includes('Math.max(10, cols - 4)'))
  check('NavigablePanes footer budget floors at ZERO', panes.includes('Math.max(0, cols - 4)') && !panes.includes('Math.max(10, cols - 4)'))
  check('NavigablePanes width floors are DEAD (owner clamp only)', !panes.includes('Math.max(20, innerPaneWidth') && !panes.includes('Math.max(16, innerWidth'))
  // regionChrome declares its own chrome height (the shell's
  // border+brand+footer stand down there) — the reserve is a ternary over it,
  // still through the ONE viewportRows owner, still composer-aware.
  check('NavigablePanes height budget rides viewportRows (aspirational min)', panes.includes('viewportRows(termRows, {') && panes.includes("(regionChrome ? regionChrome.chromeRows : VIEWPORT_RESERVE) +") && panes.includes('(composerSlot?.node ? (composerSlot.rows ?? COMPOSER_SLOT_RESERVE) : 0)') && !panes.includes('Math.max(3, termRows - VIEWPORT_RESERVE)'))
  check('NavigablePanes fold split rides viewportRows too', panes.includes('viewportRows(viewportBudget, { reserve: detailBaseRows + 1, min: 3 })'))
}

console.log('')
if (failures > 0) {
  console.log(`❌ geometry: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ geometry — clamped frames, one window function, packed one-line help, declared shedding, real adoption')
