
import type { DOMElement } from './dom.js'

export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  reach?: { x: number; y: number; width: number; height: number }
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

const parentsThatLostAChild = new WeakSet<DOMElement>()

export function noteChildRemoved(parent: DOMElement): void {
  parentsThatLostAChild.add(parent)
}

export function consumeChildRemoved(parent: DOMElement): boolean {
  return parentsThatLostAChild.delete(parent)
}

export function consumeAbsoluteRemovedFlag(root: DOMElement): boolean {
  if (!absoluteRemovedRoots.has(root)) return false
  absoluteRemovedRoots.delete(root)
  return true
}

const reachingChildren = new WeakMap<DOMElement, Set<DOMElement>>()

export function setChildReach(
  parent: DOMElement,
  child: DOMElement,
  reaches: boolean,
): void {
  let set = reachingChildren.get(parent)
  if (reaches) {
    if (!set) {
      set = new Set()
      reachingChildren.set(parent, set)
    }
    set.add(child)
  } else if (set) {
    set.delete(child)
    if (set.size === 0) reachingChildren.delete(parent)
  }
}

export function hasReachingChild(parent: DOMElement): boolean {
  const set = reachingChildren.get(parent)
  return set !== undefined && set.size > 0
}

const nestedScrollContents = new WeakSet<DOMElement>()

export function setHasNestedScroll(content: DOMElement, has: boolean): void {
  if (has) nestedScrollContents.add(content)
  else nestedScrollContents.delete(content)
}

export function hasNestedScroll(content: DOMElement): boolean {
  return nestedScrollContents.has(content)
}
