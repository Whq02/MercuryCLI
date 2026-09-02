/**
 * Edge-based visible-window computation for horizontal item strips.
 */
export type HorizontalScrollWindow = {
  startIndex: number
  endIndex: number
  showLeftArrow: boolean
  showRightArrow: boolean
}

/**
 * Compute the visible window. Item widths include their separator where
 * applicable; when `firstItemHasSeparator` is set, the first item's width
 * counts a leading separator that is never actually drawn, so a range that
 * starts after index zero is one column narrower. The effective available
 * width subtracts one arrow width per arrow that would be shown.
 *
 * The window is edge-based, not centred: expand from index zero as far as
 * fits; if the selected item is inside, done; if it is to the right, place
 * it at the right edge and expand leftwards. (The mirror "selected is to
 * the left" branch is unreachable — the initial window starts at zero and
 * the selected index is clamped non-negative — and is not reproduced.)
 */
export function calculateHorizontalScrollWindow(
  itemWidths: number[],
  availableWidth: number,
  arrowWidth: number,
  selectedIdx: number,
  firstItemHasSeparator: boolean = true,
): HorizontalScrollWindow {
  const total = itemWidths.length
  if (total === 0) {
    return { startIndex: 0, endIndex: 0, showLeftArrow: false, showRightArrow: false }
  }
  const selected = Math.max(0, Math.min(total - 1, selectedIdx))

  const rangeWidth = (start: number, end: number): number => {
    let width = 0
    for (let i = start; i < end; i++) width += itemWidths[i] as number
    if (start > 0 && firstItemHasSeparator) width -= 1
    return width
  }
  const effectiveWidth = (start: number, end: number): number =>
    availableWidth - (start > 0 ? arrowWidth : 0) - (end < total ? arrowWidth : 0)

  if (rangeWidth(0, total) <= availableWidth) {
    return { startIndex: 0, endIndex: total, showLeftArrow: false, showRightArrow: false }
  }

  // Expand from index zero as far as fits (the first item always included).
  let end = 1
  while (end < total && rangeWidth(0, end + 1) <= effectiveWidth(0, end + 1)) {
    end++
  }
  if (selected < end) {
    return { startIndex: 0, endIndex: end, showLeftArrow: false, showRightArrow: end < total }
  }

  // Selected is to the right: pin it at the right edge, expand leftwards
  // (the selected item always included).
  const rightEnd = selected + 1
  let start = selected
  while (start > 0 && rangeWidth(start - 1, rightEnd) <= effectiveWidth(start - 1, rightEnd)) {
    start--
  }
  return {
    startIndex: start,
    endIndex: rightEnd,
    showLeftArrow: start > 0,
    showRightArrow: rightEnd < total,
  }
}
