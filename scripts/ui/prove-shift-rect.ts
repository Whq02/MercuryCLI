#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-shift-rect.ts — unit oracle for Screen.shiftRect (the
//  column-scoped scroll fast path).
//
//  The rail-drag invariant AT MODEL LEVEL: a shift bounded to [x0,x1) must
//  leave every cell outside those columns byte-identical (the
//  DECSTBM rail-drag class can never reproduce through this path), move the
//  in-rect rows exactly, clear the exposed edge, clear row-scoped softWrap,
//  and behave for both directions + the over-shift degenerate case.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-shift-rect.ts
// ============================================================================
import {
  type Cell,
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  isEmptyCellAt,
  setCellAt,
  shiftRect,
} from '../../src/ink/cell-grid.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const W = 40
const H = 12
const X0 = 10
const X1 = 30
const pool = new StylePool()

function freshScreen() {
  const s = createScreen(W, H, pool, new CharPool(), new HyperlinkPool())
  const put = (x: number, y: number, ch: string): void => {
    const cell: Cell = { char: ch, styleId: pool.none, width: CellWidth.Normal, hyperlink: undefined }
    setCellAt(s, x, y, cell)
  }
  // Rails (outside [X0,X1)) carry the row's UPPERCASE letter; the pane
  // carries lowercase — any move or corruption is attributable exactly.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) put(x, y, String.fromCharCode(65 + y))
    for (let x = X0; x < X1; x++) put(x, y, String.fromCharCode(97 + y))
  }
  s.softWrap.fill(1)
  return s
}

const charAt = (s: ReturnType<typeof createScreen>, x: number, y: number) => cellAt(s, x, y)?.char ?? ''

console.log('prove-shift-rect')

// §1 shift up (n=3) — rows 2..9, columns [10,30)
{
  const s = freshScreen()
  const outside: string[] = []
  for (let y = 0; y < H; y++) for (const x of [0, 5, 9, 30, 35, 39]) outside.push(charAt(s, x, y))
  shiftRect(s, 2, 9, X0, X1, 3)
  const outsideAfter: string[] = []
  for (let y = 0; y < H; y++) for (const x of [0, 5, 9, 30, 35, 39]) outsideAfter.push(charAt(s, x, y))
  check('§1 every cell OUTSIDE [x0,x1) byte-identical (rail-drag impossible)', outside.join('') === outsideAfter.join(''))
  check('§1 in-rect rows moved up by 3 (row 2 shows old row 5)', charAt(s, X0, 2) === 'f' && charAt(s, X1 - 1, 2) === 'f')
  check('§1 last moved row correct (row 6 shows old row 9)', charAt(s, 15, 6) === 'j')
  check('§1 exposed bottom rows cleared in-rect', isEmptyCellAt(s, 15, 7) && isEmptyCellAt(s, 15, 9))
  check('§1 rows outside the band untouched in-rect (row 0/10)', charAt(s, 15, 0) === 'a' && charAt(s, 15, 10) === 'k')
  let swCleared = true
  for (let r = 2; r <= 9; r++) if (s.softWrap[r] !== 0) swCleared = false
  check('§1 softWrap cleared across the shifted band only', swCleared && s.softWrap[0] === 1 && s.softWrap[10] === 1)
}

// §2 shift down (n=-2)
{
  const s = freshScreen()
  shiftRect(s, 2, 9, X0, X1, -2)
  check('§2 in-rect rows moved down by 2 (row 4 shows old row 2)', charAt(s, 15, 4) === 'c')
  check('§2 bottom of band shows old row 7', charAt(s, 15, 9) === 'h')
  check('§2 exposed top rows cleared in-rect', isEmptyCellAt(s, 15, 2) && isEmptyCellAt(s, 15, 3))
  check('§2 outside columns untouched', charAt(s, 5, 4) === 'E' && charAt(s, 35, 9) === 'J')
}

// §3 over-shift (|n| > band) clears the whole in-rect band, nothing else
{
  const s = freshScreen()
  shiftRect(s, 4, 6, X0, X1, 9)
  check('§3 over-shift clears the in-rect band', isEmptyCellAt(s, 15, 4) && isEmptyCellAt(s, 15, 6))
  check('§3 over-shift leaves outside columns + rows', charAt(s, 5, 5) === 'F' && charAt(s, 15, 7) === 'h')
}

// §4 degenerate guards: zero delta, inverted band, empty span — all no-ops
{
  const s = freshScreen()
  const snap = (): string => {
    let out = ''
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out += charAt(s, x, y) || '.'
    return out
  }
  const before = snap()
  shiftRect(s, 3, 8, X0, X1, 0)
  shiftRect(s, 8, 3, X0, X1, 2)
  shiftRect(s, 3, 8, 20, 20, 2)
  shiftRect(s, -1, 8, X0, X1, 2)
  shiftRect(s, 3, H, X0, X1, 2)
  check('§4 degenerate inputs are strict no-ops', snap() === before)
}

console.log(failures === 0 ? '\n✓ prove-shift-rect: all green' : `\n✗ prove-shift-rect: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
