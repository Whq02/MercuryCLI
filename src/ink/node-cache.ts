import type { DOMElement } from './dom.js'
import { notBuilt, unbuilt } from '../pi/holes.js'

export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  reach?: { x: number; y: number; width: number; height: number }
}

export const nodeCache: WeakMap<DOMElement, CachedLayout> = unbuilt('src/ink/node-cache.ts:12')

export const pendingClears: WeakMap<DOMElement, CachedLayout[]> = unbuilt('src/ink/node-cache.ts:14')

const absoluteRemovedRoots: WeakSet<DOMElement> = unbuilt('src/ink/node-cache.ts:16')

export function addPendingClear(
  parent: DOMElement,
  rect: CachedLayout,
  isAbsolute: boolean,
): void {
  return notBuilt('src/ink/node-cache.ts:18')
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
