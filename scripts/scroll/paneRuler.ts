// ============================================================================
//  scripts/scroll/paneRuler.ts — the transcript pane of a captured frame, and
//  the signature rows read from it ALONE.
//
//  The scroll provers seed a transcript whose rows carry signatures
//  ("TURN-297 line 04 …") and reconstruct the viewport's content position
//  from the first signature on screen. Read across the whole grid that
//  first signature is not the pane's: the cockpit's WORKBENCH rail prints
//  the session's last prompt ("TURN-300 please survey") at row 12 in every
//  frame, the seat line and the keyless notification rows under the
//  composer print "TURN-001 please survey" — so twelve real page-ups read
//  as twelve zero deltas, and a settled step was measured against a
//  viewport that counted rail rows. This owner cuts the pane:
//
//    · cockpit tier (a session box with '✶ SESSION' in its header row):
//      the rows inside that box, each row's OWN cells between the box's
//      left and right borders, from the header row to the box's bottom
//      edge — minus the critter card, a nested box at the top of the pane
//      that is chrome above the scroller, not transcript;
//    · deck tier (no session box): the rows after the header box's bottom
//      edge up to the first strip row (the tabs, the flow line, the frame
//      band, the seat line, the composer box).
//
//  `viewportRows` is the physical transcript region — the scroller's
//  viewport plus, when scrolled, the sticky-prompt header row and the jump
//  pill's reserved row — so a page step of viewport − 2 measures at least
//  region − 4 and never more than region + 1.
// ============================================================================

export type Grid = Array<Array<{ c: string }>>
export type PaneRow = { row: number; text: string }
export type Sig = { turn: number; sig: string; row: number }

export const SIG_RE = /TURN-(\d{3})( please survey| line (\d{2}))/

const rowText = (cells: Array<{ c: string }>): string =>
  cells.map(c => (c.c === undefined || c.c === '' ? ' ' : c.c)).join('')

/** The transcript pane's rows (absolute row index + the pane's own text). */
export function paneRows(grid: Grid): PaneRow[] {
  const rows = grid.map(rowText)
  const head = rows.findIndex(r => r.includes('✶ SESSION'))
  if (head >= 0) {
    const line = rows[head]!
    const x0 = line.indexOf('│')
    const x1 = line.lastIndexOf('│')
    const inner: PaneRow[] = []
    for (let y = head + 1; y < rows.length; y++) {
      const r = rows[y]!
      if (r[x0] === '╰') break
      inner.push({ row: y, text: r.slice(x0 + 1, x1) })
    }
    // The critter card: a nested box at the top of the pane (chrome above
    // the scroller). Skip it whole — its top edge to its bottom edge.
    if (inner.length > 0 && /^\s*╭/.test(inner[0]!.text)) {
      const end = inner.findIndex(p => /^\s*╰/.test(p.text))
      return end >= 0 ? inner.slice(end + 1) : inner
    }
    return inner
  }
  // Deck tier: the header box closes at its bottom edge; the transcript runs
  // to the first strip row.
  const out: PaneRow[] = []
  let y = 0
  if (/^\s*╭/.test(rows[0] ?? '')) {
    const end = rows.findIndex(r => /^\s*╰/.test(r))
    y = end >= 0 ? end + 1 : 0
  }
  for (; y < rows.length; y++) {
    const r = rows[y]!
    if (/^\s*(⊞|✦|▚▛|◐|╭)/.test(r)) break
    out.push({ row: y, text: r })
  }
  return out
}

/** Signature rows of the pane, in row order. */
export function paneSigs(grid: Grid): Sig[] {
  const out: Sig[] = []
  for (const p of paneRows(grid)) {
    const m = p.text.match(SIG_RE)
    if (m) out.push({ turn: Number(m[1]), sig: m[3] ?? 'u', row: p.row })
  }
  return out
}

/** The physical transcript region of the frame, in rows. */
export function viewportRows(grid: Grid): number {
  return paneRows(grid).length
}

/** The bounds a settled page step must sit in for a region of `rows`:
 *  the scroller's viewport is the region less the sticky-prompt header and
 *  the jump pill's row when scrolled, and a page keeps two overlap rows. */
export function stepBounds(rows: number): { floor: number; ceiling: number } {
  return { floor: Math.max(1, rows - 4), ceiling: rows + 1 }
}
