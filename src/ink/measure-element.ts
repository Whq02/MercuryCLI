// Public measurement of a mounted element's computed size.

import type { DOMElement } from './dom.js'

export default function measureElement(node: DOMElement): {
  width: number
  height: number
} {
  const layout = node.layoutNode
  if (!layout) return { width: 0, height: 0 }
  return {
    width: layout.getComputedWidth(),
    height: layout.getComputedHeight(),
  }
}

/** The element's absolute screen column: computed lefts summed up the
 *  parent chain — the same accumulation the compose walk performs from the
 *  root (compose-walk: x = parentX + getComputedLeft()). The current-match
 *  search overlay needs it because scanElementSubtree's match positions
 *  are ELEMENT-relative (composed at offsetX −left), while the overlay
 *  paints in screen space (FN-016 R6). */
export function elementScreenLeft(node: DOMElement): number {
  let left = 0
  let cur: DOMElement | undefined = node
  while (cur) {
    const layout = cur.layoutNode
    if (layout) left += layout.getComputedLeft()
    cur = cur.parentNode
  }
  return left
}

/** The element's absolute screen row: computed tops summed up the parent
 *  chain (the row twin of elementScreenLeft). A bottom-anchored surface that
 *  budgets its own rows — the shortcut grid caps itself to the rows the
 *  screen still holds beneath it — reads the rows above it from this, not
 *  from a chrome constant. */
export function elementScreenTop(node: DOMElement): number {
  let top = 0
  let cur: DOMElement | undefined = node
  while (cur) {
    const layout = cur.layoutNode
    if (layout) top += layout.getComputedTop()
    cur = cur.parentNode
  }
  return top
}
