
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
