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
  firstItemHasSeparator: boolean = false,
): HorizontalScrollWindow {
  const count = itemWidths.length
  if (count === 0) {
    return { startIndex: 0, endIndex: 0, showLeftArrow: false, showRightArrow: false }
  }

  const prefix = new Array<number>(count + 1)
  prefix[0] = 0
  for (let i = 0; i < count; i++) {
    prefix[i + 1] = prefix[i]! + itemWidths[i]!
  }

  const fits = (start: number, end: number): boolean => {
    const items = end - start
    const separators = items > 0 ? items - 1 + (firstItemHasSeparator ? 1 : 0) : 0
    const arrows = (start > 0 ? arrowWidth : 0) + (end < count ? arrowWidth : 0)
    return prefix[end]! - prefix[start]! + separators + arrows <= availableWidth
  }

  if (fits(0, count)) {
    return { startIndex: 0, endIndex: count, showLeftArrow: false, showRightArrow: false }
  }

  const selected = Math.max(0, Math.min(selectedIdx, count - 1))
  let start = selected
  let end = selected + 1
  let preferRight = true

  for (;;) {
    const canRight = end < count && fits(start, end + 1)
    const canLeft = start > 0 && fits(start - 1, end)
    if (!canRight && !canLeft) break
    if (preferRight) {
      if (canRight) end++
      else start--
    } else {
      if (canLeft) start--
      else end++
    }
    preferRight = !preferRight
  }

  return {
    startIndex: start,
    endIndex: end,
    showLeftArrow: start > 0,
    showRightArrow: end < count,
  }
}
