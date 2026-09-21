import {
  remapStylesOutside,
  type RecessTransform,
  type Screen,
  type StylePool,
} from './cell-grid.js'
import type { DOMElement } from './dom.js'
import instances from './instances.js'
import { nodeCache } from './node-cache.js'

const registrants = new Set<DOMElement>()
let target: RecessTransform | null = null

export function registerElevatedSurface(el: DOMElement): () => void {
  registrants.add(el)
  return () => {
    registrants.delete(el)
    if (target !== null) {
      instances.get(process.stdout)?.invalidatePrevFrame()
    }
  }
}

export function setRecessTarget(t: RecessTransform | null): void {
  const changed =
    (target === null) !== (t === null) ||
    (target !== null &&
      t !== null &&
      (target.canvas.join() !== t.canvas.join() ||
        target.ink.join() !== t.ink.join() ||
        target.quantize256 !== t.quantize256))
  const hadWork = registrants.size > 0 && (target !== null || t !== null)
  target = t
  if (changed && hadWork) {
    instances.get(process.stdout)?.invalidatePrevFrame()
  }
}

type Rect = { x: number; y: number; width: number; height: number }

function rectContains(rect: Rect, col: number, row: number): boolean {
  return col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height
}

function rectHosts(host: Rect, guest: Rect): boolean {
  if (host === guest) return false
  const within = guest.x >= host.x && guest.y >= host.y && guest.x + guest.width <= host.x + host.width && guest.y + guest.height <= host.y + host.height
  const same = guest.x === host.x && guest.y === host.y && guest.width === host.width && guest.height === host.height
  return within && !same
}

export function elevatedSurfaceContains(col: number, row: number): boolean | null {
  const rects: Rect[] = []
  for (const el of registrants) {
    const rect = nodeCache.get(el)
    if (rect) rects.push(rect)
  }
  if (rects.length === 0) return null
  for (const rect of rects) {
    if (rects.some(other => rectHosts(rect, other))) continue
    if (rectContains(rect, col, row)) return true
  }
  return false
}

export function recessActive(): boolean {
  return target !== null && registrants.size > 0
}

export function hasElevatedSurface(): boolean {
  return registrants.size > 0
}

export function applyRecessPass(screen: Screen, stylePool: StylePool): number {
  if (target === null || registrants.size === 0) {
    stylePool.setRecessTransform(null)
    return 0
  }
  const rects = []
  for (const el of registrants) {
    const rect = nodeCache.get(el)
    if (rect) rects.push(rect)
  }
  if (rects.length === 0) return 0
  stylePool.setRecessTransform(target)
  return remapStylesOutside(screen, rects, id => stylePool.withRecess(id))
}
