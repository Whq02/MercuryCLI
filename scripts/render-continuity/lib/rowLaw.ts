export type RowFrame = { atMs: number; row: number; cardRows: number | null }

export function downOnlyWithCard(frames: readonly RowFrame[]): { ok: boolean; detail: string } {
  const present = frames.filter(f => f.row !== -1)
  let growths = 0
  for (let i = 1; i < present.length; i++) {
    const before = present[i - 1]!
    const after = present[i]!
    const shift = after.row - before.row
    if (shift <= 0) continue
    const cardShift = (after.cardRows ?? 0) - (before.cardRows ?? 0)
    if (shift !== cardShift) {
      return { ok: false, detail: `@${before.atMs}→@${after.atMs}: row ${before.row}→${after.row} while the card went ${before.cardRows ?? 0}→${after.cardRows ?? 0} lines` }
    }
    growths++
  }
  if (growths > 1) return { ok: false, detail: `${growths} downward moves with the card (one growth a turn)` }
  return { ok: true, detail: `rows ${[...new Set(present.map(f => f.row))].join(',')}` }
}
