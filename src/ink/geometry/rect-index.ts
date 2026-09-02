// ============================================================================
//  rect-index.ts — T7: the committed rect plane.
//
//  Input geometry (hit-testing, click dispatch, clip-band resolution) must
//  only ever read rects the compose walk COMMITTED — never an uncommitted
//  layout generation (the stale-rect law prove-hit-map pins: after a
//  re-layout, old coordinates hit the NEW occupant). The index is the
//  explicit T6↔T7 seam: the render side writes nodeCache during compose;
//  the geometry side reads through this projection and takes it as a
//  PARAMETER, so a law rig can hand in its own index and the production
//  callers keep the committed one.
// ============================================================================
import type { DOMElement } from '../dom.js'
import { type CachedLayout, nodeCache } from '../node-cache.js'

export type RectIndex = {
  get(el: DOMElement): CachedLayout | undefined
}

/** The production index: the rects the compose walk committed this frame
 *  (screen coordinates, scrollTop translation already applied; absent ⇒
 *  the node did not render this frame). */
export const committedRects: RectIndex = {
  get: el => nodeCache.get(el),
}
