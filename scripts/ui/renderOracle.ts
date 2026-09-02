export type GridCell = { c: string }
export type CapturedGrid = { cols: number; rows: number; grid: GridCell[][] }

export const BOOT_ERROR_SIGNATURES = [
  'No conversation found',
]

export const CHROME_MARKERS = ['❯', '╭', '│', '╰']

export function countPainted(g: CapturedGrid): number {
  return g.grid.reduce((n, row) => n + row.filter(c => c.c && c.c !== ' ').length, 0)
}

export function evaluateCapture(
  g: CapturedGrid,
  markers: string[] = CHROME_MARKERS,
): { ok: boolean; reason: string } {
  const painted = countPainted(g)
  if (painted < 40) {
    return { ok: false, reason: `blank/partial capture: ${painted} painted cells (binary did not paint)` }
  }
  const text = g.grid.map(row => row.map(c => c.c ?? '').join('')).join('\n')
  const topText = g.grid.slice(0, 3).map(row => row.map(c => c.c ?? '').join('')).join('\n')
  const sig = BOOT_ERROR_SIGNATURES.find(s => topText.includes(s))
  if (sig) {
    return { ok: false, reason: `boot-error screen captured: "${sig}" (session/config staging mismatch?)` }
  }
  if (!markers.some(m => text.includes(m))) {
    return { ok: false, reason: `no expected chrome painted (looked for: ${markers.join(' ')})` }
  }
  return { ok: true, reason: `${painted} painted cells, chrome present` }
}
