// Per-node committed rect cache, pending-clear rects, and the per-root
// absolute-removal flag. The flag is PER ROOT, never a module global: a
// global cross-talked between instances in one process — one instance's
// overlay unmount forced a full render on every other instance's next
// frame, or was consumed by whichever rendered first, losing the other's
// ghost repair.

import type { DOMElement } from './dom.js'

export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  /** Layout-local computed top, stored so viewport culling can skip layout
   *  reads for clean, unmoved children. */
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
    // Absolute positioning lets pixels land anywhere on screen; the only
    // safe response is denying the whole next frame the previous-screen
    // blit, flagged on the tree's root.
    let root: DOMElement = parent
    while (root.parentNode) root = root.parentNode
    absoluteRemovedRoots.add(root)
  }
}

/** Read AND clear the root's absolute-removal flag. */
export function consumeAbsoluteRemovedFlag(root: DOMElement): boolean {
  if (!absoluteRemovedRoots.has(root)) return false
  absoluteRemovedRoots.delete(root)
  return true
}
