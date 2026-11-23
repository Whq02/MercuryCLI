type HorizontalScrollWindow = {
  startIndex: number
  endIndex: number
  showLeftArrow: boolean
  showRightArrow: boolean
}

export function calculateHorizontalScrollWindow(
  itemWidths: number[],
  availableWidth: number,
  arrowWidth: number,
  selectedIdx: number,
  firstItemHasSeparator: boolean = true,
): HorizontalScrollWindow {
  const count = itemWidths.length
  if (count === 0) {
    return { startIndex: 0, endIndex: 0, showLeftArrow: false, showRightArrow: false }
  }

  const selected = Math.max(0, Math.min(selectedIdx, count - 1))

  const prefix = new Array<number>(count + 1)
  prefix[0] = 0
  for (let i = 0; i < count; i++) {
    prefix[i + 1] = prefix[i]! + itemWidths[i]!
  }

  if (prefix[count]! <= availableWidth) {
    return { startIndex: 0, endIndex: count, showLeftArrow: false, showRightArrow: false }
  }

  const fits = (start: number, end: number): boolean => {
    const rawWidth = prefix[end]! - prefix[start]!
    const adjustedWidth = start > 0 && firstItemHasSeparator ? rawWidth - 1 : rawWidth
    const arrows = (start > 0 ? arrowWidth : 0) + (end < count ? arrowWidth : 0)
    return adjustedWidth + arrows <= availableWidth
  }

  let prefixEnd = 0
  while (prefixEnd < count && fits(0, prefixEnd + 1)) {
    prefixEnd++
  }

  if (selected < prefixEnd) {
    return {
      startIndex: 0,
      endIndex: prefixEnd,
      showLeftArrow: false,
      showRightArrow: prefixEnd < count,
    }
  }

  const end = selected + 1
  let start = selected
  while (start > 0 && fits(start - 1, end)) {
    start--
  }

  return {
    startIndex: start,
    endIndex: end,
    showLeftArrow: start > 0,
    showRightArrow: end < count,
  }
}
