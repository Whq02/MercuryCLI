
import { stringWidth } from '../../ink/stringWidth.js'

export { paneWindow, scrolledWindow, fitGroupedWindow, fitMeasuredWindow, type PaneWindow } from './paneWindow.js'

export type FrameSpec = {
  border?: boolean
  paddingX?: number
  marginX?: number
}

export function frameCells(spec: FrameSpec = {}): number {
  const border = spec.border === false ? 0 : 2
  return border + 2 * (spec.paddingX ?? 0) + 2 * (spec.marginX ?? 0)
}

export function innerWidth(total: number, spec: FrameSpec = {}): number {
  return Math.max(0, Math.floor(total) - frameCells(spec))
}

export function panelWidth(
  columns: number,
  opts: { cap?: number; reserve?: number; min?: number } = {},
): number {
  const cols = Math.max(0, Math.floor(columns))
  const reserve = Math.max(0, opts.reserve ?? 2)
  const cap = opts.cap ?? Number.POSITIVE_INFINITY
  const min = Math.max(0, opts.min ?? 0)
  const usable = Math.max(0, cols - reserve)
  return Math.min(cols, Math.max(min, Math.min(cap, usable)))
}

export function viewportRows(
  rows: number,
  opts: { reserve?: number; min?: number; cap?: number } = {},
): number {
  const total = Math.max(0, Math.floor(rows))
  const reserve = Math.max(0, opts.reserve ?? 0)
  const cap = opts.cap ?? Number.POSITIVE_INFINITY
  const available = Math.max(0, total - reserve)
  const aspiration = Math.min(Math.max(0, opts.min ?? 1), available, cap)
  return Math.max(aspiration, Math.min(cap, available))
}

export function packHints(
  segments: readonly string[],
  budget: number,
  sep = ' · ',
): string {
  const parts = segments.filter(s => s.length > 0)
  if (parts.length === 0 || budget <= 0) return ''
  let out = ''
  let dropped = false
  for (const seg of parts) {
    const candidate = out.length === 0 ? seg : out + sep + seg
    if (stringWidth(candidate) <= budget) {
      out = candidate
    } else {
      dropped = true
      break
    }
  }
  if (dropped && out.length > 0) {
    const withEllipsis = out + ' …'
    if (stringWidth(withEllipsis) <= budget) return withEllipsis
  }
  return out
}

export function packLines(
  segments: readonly string[],
  budget: number,
  sep = ' · ',
): string[] {
  const parts = segments.map(s => s.trim()).filter(s => s.length > 0)
  if (parts.length === 0 || budget <= 0) return []
  const lines: string[] = []
  let line = ''
  for (const seg of parts) {
    const candidate = line.length === 0 ? seg : line + sep + seg
    if (line.length === 0 || stringWidth(candidate) <= budget) {
      line = candidate
    } else {
      lines.push(line)
      line = seg
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

export function shedToFit<T extends { text: string; priority: number }>(
  parts: readonly T[],
  budget: number,
  sep = ' · ',
): T[] {
  const kept = [...parts]
  const width = (list: readonly T[]): number =>
    stringWidth(list.map(p => p.text).join(sep))
  while (kept.length > 0 && width(kept) > budget) {
    let dropIdx = 0
    for (let i = 1; i < kept.length; i++) {
      if (kept[i]!.priority <= kept[dropIdx]!.priority) dropIdx = i
    }
    kept.splice(dropIdx, 1)
  }
  return kept
}

export function cockpitBottomSlotReserve(termRows: number): number {
  return Math.ceil(termRows / 2) + 12
}
