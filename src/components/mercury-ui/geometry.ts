// ============================================================================
//  geometry — the shared responsive-geometry contracts.
//
//  The arithmetic every interactive surface kept re-deriving by hand (72
//  `columns - N` sites, per-surface chrome guesses), spelled ONCE and clamped
//  at zero. Widths are DISPLAY CELLS via the ONE width oracle (stringWidth —
//  borders, cursor and text must share it),
//
//  Laws (proved in scripts/navigation/prove-geometry.ts):
//   · computed widths/heights clamp at zero — never negative;
//   · a panel never claims more than the terminal rectangle;
//   · frame chrome (border + padding + margin) is counted once, here;
//   · one-line hint packing keeps COMPLETE segments only, never ends with a
//     dangling separator, and appends the ellipsis only when it fits;
//   · shedding follows a DECLARED priority order (drop whole units
//     right-to-left), never equal truncation of every field.
//
//  paneWindow (paneWindow.ts) stays THE cursor-following window function —
//  this module deliberately re-exports it so surfaces import ONE geometry
//  vocabulary.
// ============================================================================

import { stringWidth } from '../../ink/stringWidth.js'

export { paneWindow, scrolledWindow, fitGroupedWindow, fitMeasuredWindow, type PaneWindow } from './paneWindow.js'

/** Frame chrome a boxed surface wears: border cells + padding + margin. */
export type FrameSpec = {
  /** Round/single border: 1 cell each side. Default true. */
  border?: boolean
  /** paddingX cells each side. Default 0. */
  paddingX?: number
  /** marginX cells each side. Default 0. */
  marginX?: number
}

/** Horizontal chrome cells consumed by a frame (both sides summed). */
export function frameCells(spec: FrameSpec = {}): number {
  const border = spec.border === false ? 0 : 2
  return border + 2 * (spec.paddingX ?? 0) + 2 * (spec.marginX ?? 0)
}

/** Content width inside a frame — clamped at zero, never negative. */
export function innerWidth(total: number, spec: FrameSpec = {}): number {
  return Math.max(0, Math.floor(total) - frameCells(spec))
}

/** A dialog panel's total width: capped, reserved against the terminal edge,
 *  floored — and NEVER wider than the terminal itself (a dialog never draws
 *  outside the available rectangle). */
export function panelWidth(
  columns: number,
  opts: { cap?: number; reserve?: number; min?: number } = {},
): number {
  const cols = Math.max(0, Math.floor(columns))
  const reserve = Math.max(0, opts.reserve ?? 2)
  const cap = opts.cap ?? Number.POSITIVE_INFINITY
  const min = Math.max(0, opts.min ?? 0)
  const usable = Math.max(0, cols - reserve)
  // The floor bounds the CLAMP, the terminal bounds the floor: min wins over
  // cap/reserve on narrow screens, but nothing ever exceeds the terminal.
  return Math.min(cols, Math.max(min, Math.min(cap, usable)))
}

/** Bounded viewport height for a scrolling region inside chrome: the terminal
 *  rows minus a declared chrome reserve.
 *
 *  THE HEIGHT LAW (MINI-TEMPER item 4): the returned height can never exceed
 *  the terminal rows, the post-reserve availability, or the cap — zero
 *  available rows means ZERO. `min` is ASPIRATIONAL: it floors the result
 *  only within those absolute bounds (min(min, available, cap)) and can
 *  never manufacture rows the terminal lacks — the pre-fix Math.max(min, …)
 *  painted min rows into negative space on a sub-reserve terminal. */
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

/** One-line contextual help packing: greedily keep COMPLETE segments in
 *  priority order (first = most important), joined by the separator. The
 *  result never exceeds the budget, never ends with a dangling separator, and
 *  gains a trailing ellipsis only when segments were dropped AND it fits. */
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

/** Wrap `segments` (display order, the ' · ' grammar) onto as few lines as
 *  fit `budget`: a line takes whole segments greedily and a segment wider
 *  than the budget stands alone (the renderer truncates it). Nothing is
 *  dropped — the caller pays a row per line and every unit reads whole,
 *  where a single truncate-end row would cut the last unit mid-phrase. */
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

/** Shed by DECLARED priority: keep the parts whose combined width fits,
 *  dropping the LOWEST-priority whole units first (secondary information
 *  yields before the primary label; a unit hides completely, never half).
 *  `parts` are given in display order; `priority` ranks keepability
 *  (higher = kept longer). Returns the surviving parts in display order. */
export function shedToFit<T extends { text: string; priority: number }>(
  parts: readonly T[],
  budget: number,
  sep = ' · ',
): T[] {
  const kept = [...parts]
  const width = (list: readonly T[]): number =>
    stringWidth(list.map(p => p.text).join(sep))
  while (kept.length > 0 && width(kept) > budget) {
    // Drop the lowest-priority unit; ties drop the RIGHTMOST (right-to-left).
    let dropIdx = 0
    for (let i = 1; i < kept.length; i++) {
      if (kept[i]!.priority <= kept[dropIdx]!.priority) dropIdx = i
    }
    kept.splice(dropIdx, 1)
  }
  return kept
}

/** LUSTRE L4 — the COCKPIT bottom-slot reserve for the
 *  quick-open overlays. The cockpit's bottom area is capped at 50% of the
 *  terminal, and the palette shares it with the ⊞ SESSIONS card + its own
 *  ~9 rows of chrome — so the honest reserve SCALES with the terminal
 *  (ceil(rows/2) + 12) instead of sitting constant. The old constant 32 was
 *  tuned at 40 rows (where this formula is identical) and over-granted +1
 *  list row per +1 terminal row above it: at 44 rows the list overflowed
 *  the slot and yoga SQUEEZED rows — the selected action row could vanish
 *  while the counter line blended into a neighbor (the
 *  clipped-tail class, still live on tall terminals). */
export function cockpitBottomSlotReserve(termRows: number): number {
  return Math.ceil(termRows / 2) + 12
}
