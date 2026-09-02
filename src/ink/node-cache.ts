// global cross-talked between instances in one process — one instance's

import type { DOMElement } from './dom.js'

export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  top?: number
}

export const nodeCache = new WeakMap<DOMElement, CachedLayout>()

export const pendingClears = new WeakMap<DOMElement, CachedLayout[]>()

const absoluteRemovedRoots = new WeakSet<DOMElement>()

export function addPendingClear(
  parent: DOMElement,
  rect: CachedLayout,
  isAbsolute: boolean,
): void {
  const rects = pendingClears.get(parent)
  if (rects) rects.push(rect)
  else pendingClears.set(parent, [rect])
  if (isAbsolute) {
    let root: DOMElement = parent
    while (root.parentNode) root = root.parentNode
    absoluteRemovedRoots.add(root)
  }
}

export function consumeAbsoluteRemovedFlag(root: DOMElement): boolean {
  if (!absoluteRemovedRoots.has(root)) return false
  absoluteRemovedRoots.delete(root)
  return true
}
