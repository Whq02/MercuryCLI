// ============================================================================
//  scripts/ui/frameChecks.ts — the frame readings the capture probes share.
//
//  ONE checker for the overflow class (border integrity · bleed · clip · the
//  way out · the footer on one line) — probe-overflow-matrix owns the census
//  and probe-resize-matrix reuses the same reading on every settled frame,
//  so a border broken by a resize and a border broken by a wrapped label
//  fail the same law. The resize readings beside it (the composer caret,
//  the rows a needle paints on, the painted-row census) are the pure halves
//  of the resize laws; the probes and the provers read them.
// ============================================================================

export type Cell = { c?: string }
export type Grid = Cell[][]

// A wide glyph (CJK) owns two cells: pyte hands the second back EMPTY, and
// dropping it would shorten the row by one column per glyph and shift every
// border reading to its right. An empty cell paints as a space.
export const rowsOf = (g: Grid | undefined): string[] =>
  Array.isArray(g) ? g.map(row => row.map(cell => (cell.c === undefined || cell.c === '' ? ' ' : cell.c)).join('')) : []

const BOX = new Set(['╭', '╮', '╰', '╯', '│', '─', '├', '┤', '┬', '┴', '┼', '┌', '┐', '└', '┘'])
/** A horizontal border or rule glyph AT a box's edge column: the box is cut
 *  by an enclosing border or a slot divider (a scroll viewport clipping its
 *  content, the modal slot's rule) — a container's law, never a bleed. */
const CUT = new Set(['─', '╰', '╯', '┴', '┬', '┼', '━', '▔', '▁', '═'])
export const EXIT_HINT = /\besc\b|←|\bq quits\b|⇧←|shift\+←|\bctrl\+[cd]\b/i
/** A row that reads like key hints (the footer grammar). */
const KEY_HINT_ROW = /(^|· )(↑↓|↵|←→|esc|⌫|tab|space|⇧|⌃)/
/** A full-width rule (one glyph across the whole frame): a slot divider. */
const isRule = (line: string): boolean => line.length > 0 && /^(.)\1*$/.test(line) && CUT.has(line[0]!)

export type Finding = { kind: 'broken-border' | 'bleed' | 'clip' | 'no-exit' | 'footer-wrapped'; detail: string }

/** Read one frame for the overflow class. `root` names the key-map row a
 *  root screen owes instead of an exit hint. */
export function inspect(rows: string[], cols: number, root?: RegExp): Finding[] {
  const out: Finding[] = []
  const cell = (y: number, x: number): string => rows[y]?.[x] ?? ' '
  for (let y = 0; y < rows.length; y++) {
    const line = rows[y]!
    if (isRule(line)) continue
    for (let x0 = line.indexOf('╭'); x0 >= 0; x0 = line.indexOf('╭', x0 + 1)) {
      const x1 = line.indexOf('╮', x0 + 1)
      if (x1 < 0) {
        out.push({ kind: 'broken-border', detail: `row ${y}: ╭ at ${x0} has no ╮ (the top edge is cut or overwritten)` })
        continue
      }
      // Walk down to the bottom edge.
      let closed = false
      let cut = false
      let lastInner = y
      for (let yy = y + 1; yy < rows.length; yy++) {
        const l = cell(yy, x0)
        const r = cell(yy, x1)
        if (l === '╰') {
          closed = true
          if (r !== '╯') out.push({ kind: 'broken-border', detail: `row ${yy}: bottom edge ╰ at ${x0} but ${JSON.stringify(r)} at ${x1}` })
          break
        }
        // Cut by a container: an enclosing box's bottom border or a slot
        // divider runs through this row — the box ends here by the
        // container's law (a scroll viewport clips), not by overflow.
        if (isRule(rows[yy]!) || (CUT.has(l) && l !== '│') || (CUT.has(r) && r !== '│')) {
          cut = true
          break
        }
        lastInner = yy
        // Cut by a scroll viewport: a card inside a modal's scroll body ends
        // where the body's cap ends — the next row is the shell's blank
        // margin (only the enclosing borders on it), not a broken edge.
        const marginRow = rows[yy]!.replace(/^\s*│/, '').replace(/│\s*$/, '').trim() === ''
        if (l === ' ' && r === ' ' && marginRow) {
          cut = true
          break
        }
        if (!(l === '│' || l === '├')) {
          out.push({ kind: 'broken-border', detail: `row ${yy}: left edge at ${x0} reads ${JSON.stringify(l)}` })
          break
        }
        if (!(r === '│' || r === '┤')) {
          out.push({ kind: 'broken-border', detail: `row ${yy}: right edge at ${x1} reads ${JSON.stringify(r)} — "${rows[yy]!.slice(Math.max(0, x1 - 30), x1 + 2).trim()}"` })
          break
        }
        // Bleed: a painted cell right after the border that is not another box.
        const after = cell(yy, x1 + 1)
        if (x1 + 1 < cols && after !== ' ' && !BOX.has(after)) {
          out.push({ kind: 'bleed', detail: `row ${yy}: ${JSON.stringify(after)} painted right of the border at ${x1 + 1}` })
        }
      }
      if (cut) continue
      if (!closed) {
        // The frame's bottom cut the shell: only a shell that STARTS above
        // the last few rows is a clip (a card at the very bottom is a
        // layout choice the eyeball pass judges).
        if (lastInner >= rows.length - 1 && y < rows.length - 4) {
          out.push({ kind: 'clip', detail: `shell opened at row ${y} (x ${x0}..${x1}) never closes — its footer is off screen` })
        }
        continue
      }
      // The footer law inside a closed shell wider than half the frame: the
      // last inner row carries the way out and the row above it is blank.
      if (x1 - x0 > cols / 2 && lastInner - y >= 3) {
        const inner = (yy: number): string => rows[yy]!.slice(x0 + 1, x1).trim()
        const footer = inner(lastInner)
        const above = inner(lastInner - 1)
        // A footer that wrapped leaves a row of KEY HINTS above its last
        // row; a status line above the footer (an id, a note) is the
        // surface's own body and stays legal.
        if (EXIT_HINT.test(footer) && above !== '' && KEY_HINT_ROW.test(above) && !above.includes('…')) {
          out.push({ kind: 'footer-wrapped', detail: `rows ${lastInner - 1}-${lastInner}: "${above}" / "${footer}"` })
        }
      }
    }
  }
  const whole = rows.join('\n')
  if (root !== undefined) {
    if (!root.test(whole) && !EXIT_HINT.test(whole)) out.push({ kind: 'no-exit', detail: `a root screen with no key-map row (${root}) and no exit hint` })
  } else if (!EXIT_HINT.test(whole)) {
    out.push({ kind: 'no-exit', detail: 'no esc / ← / q / ⇧← / ctrl+c hint anywhere on the frame' })
  }
  return out
}

// ── resize readings ─────────────────────────────────────────────────────────

/** The composer's caret: the pointer that opens the composer row — a '❯'
 *  preceded on its row only by borders, spaces and a mode glyph (never a
 *  transcript nameplate's '] ❯ ' nor a menu marker mid-row) — and the
 *  column right after it, where the declared cursor parks. The LAST such
 *  row is the composer (a card above it may open its own rows). */
export function composerCaret(rows: string[]): { y: number; x: number } | null {
  let found: { y: number; x: number } | null = null
  for (let y = 0; y < rows.length; y++) {
    const line = rows[y]!
    const x = line.indexOf('❯')
    if (x < 0) continue
    const before = line.slice(0, x)
    if (/^[\s│!#]*$/.test(before)) found = { y, x: x + 2 }
  }
  return found
}

/** The rows a needle paints on — a surface painted twice shows its needle
 *  on two rows. */
export function needleRows(rows: string[], needle: string): number[] {
  const hits: number[] = []
  rows.forEach((r, i) => {
    if (r.includes(needle)) hits.push(i)
  })
  return hits
}

/** The painted rows of a frame (anything beyond spaces counts — a border-only
 *  row is paint). */
export function paintedRows(rows: string[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (r.trim() !== '') out.push(i)
  })
  return out
}
