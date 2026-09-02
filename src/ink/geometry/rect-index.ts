import type { DOMElement } from '../dom.js'
import { type CachedLayout, nodeCache } from '../node-cache.js'

export type RectIndex = {
  get(el: DOMElement): CachedLayout | undefined
}

export const committedRects: RectIndex = {
  get: el => nodeCache.get(el),
}
