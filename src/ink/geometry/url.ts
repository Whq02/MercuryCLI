// ============================================================================
//  url.ts — T7: plain-text URL resolution at a cell.
//
//  Mirrors the terminal's native Cmd+Click URL detection (which fullscreen
//  mouse tracking intercepts); the OSC 8 hyperlink plane takes precedence
//  at the caller (getHyperlinkAt) — this is the fallback for bare URLs in
//  text. prove-geometry-contract URL pins the table: multi-URL runs
//  resolve by the LAST scheme anchor at/before the click; trailing
//  sentence punctuation strips; closers `)]}`strip only when UNBALANCED
//  (`/wiki/Foo_(bar)` keeps its `)`); a click past the resolved URL's
//  right edge (e.g. the comma between two URLs) resolves to nothing.
//
//  URL characters are printable ASCII minus terminal delimiters — ASCII
//  keeps cell-count === string-index, so the column-span arithmetic is
//  exact (no wide-char/grapheme drift); any wide/spacer/non-ASCII cell is
//  a boundary.
// ============================================================================
import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'

const URL_BOUNDARY = new Set([...'<>"\'` '])
function isUrlChar(c: string): boolean {
  if (c.length !== 1) return false
  const code = c.charCodeAt(0)
  return code >= 0x21 && code <= 0x7e && !URL_BOUNDARY.has(c)
}

export function findPlainTextUrlAt(
  screen: Screen,
  col: number,
  row: number,
): string | undefined {
  if (row < 0 || row >= screen.height) return undefined
  const width = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * width

  let c = col
  if (c > 0) {
    const cell = cellAt(screen, c, row)
    if (cell && cell.width === CellWidth.SpacerTail) c -= 1
  }
  if (c < 0 || c >= width || noSelect[rowOff + c] === 1) return undefined

  const startCell = cellAt(screen, c, row)
  if (!startCell || !isUrlChar(startCell.char)) return undefined

  // The URL-char run around the click (ASCII-only ⇒ 1 cell = 1 char).
  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc || pc.width !== CellWidth.Narrow || !isUrlChar(pc.char)) break
    lo = prev
  }
  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc || nc.width !== CellWidth.Narrow || !isUrlChar(nc.char)) break
    hi = next
  }

  let token = ''
  for (let i = lo; i <= hi; i++) token += cellAt(screen, i, row)!.char

  // The LAST scheme anchor at/before the click — a run like
  // `https://a.com,https://b.com` has two, and clicking the second must
  // return the second, not the greedy match of both. The NEXT anchor (if
  // any) bounds the URL's right edge.
  const clickIdx = c - lo
  const schemeRe = /(?:https?|file):\/\//g
  let urlStart = -1
  let urlEnd = token.length
  for (let m; (m = schemeRe.exec(token)); ) {
    if (m.index > clickIdx) {
      urlEnd = m.index
      break
    }
    urlStart = m.index
  }
  if (urlStart < 0) return undefined
  let url = token.slice(urlStart, urlEnd)

  // Strip trailing sentence punctuation; closers only when unbalanced.
  const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  while (url.length > 0) {
    const last = url.at(-1)!
    if ('.,;:!?'.includes(last)) {
      url = url.slice(0, -1)
      continue
    }
    const opener = OPENER[last]
    if (!opener) break
    let opens = 0
    let closes = 0
    for (let i = 0; i < url.length; i++) {
      const ch = url.charAt(i)
      if (ch === opener) opens++
      else if (ch === last) closes++
    }
    if (closes > opens) url = url.slice(0, -1)
    else break
  }

  // urlStart guarantees click ≥ URL start; the strip may have moved the
  // right edge back past the click.
  if (clickIdx >= urlStart + url.length) return undefined

  return url
}
