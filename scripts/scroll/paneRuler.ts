
export type Grid = Array<Array<{ c: string }>>
export type PaneRow = { row: number; text: string }
export type Sig = { turn: number; sig: string; row: number }

export const SIG_RE = /TURN-(\d{3})( please survey| line (\d{2}))/

const rowText = (cells: Array<{ c: string }>): string =>
  cells.map(c => (c.c === undefined || c.c === '' ? ' ' : c.c)).join('')

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
    if (inner.length > 0 && /^\s*╭/.test(inner[0]!.text)) {
      const end = inner.findIndex(p => /^\s*╰/.test(p.text))
      return end >= 0 ? inner.slice(end + 1) : inner
    }
    return inner
  }
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

export function paneSigs(grid: Grid): Sig[] {
  const out: Sig[] = []
  for (const p of paneRows(grid)) {
    const m = p.text.match(SIG_RE)
    if (m) out.push({ turn: Number(m[1]), sig: m[3] ?? 'u', row: p.row })
  }
  return out
}

export function viewportRows(grid: Grid): number {
  return paneRows(grid).length
}

export function regionOf(grids: Grid[]): number {
  const counts = new Map<number, number>()
  for (const g of grids) {
    const n = viewportRows(g)
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0
}

export function stepBounds(rows: number): { floor: number; ceiling: number } {
  return { floor: Math.max(1, rows - 4), ceiling: rows + 1 }
}
