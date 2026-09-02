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

  if (clickIdx >= urlStart + url.length) return undefined

  return url
}
