// ============================================================================
//  recessLayer — LUSTRE L1: the focused-layer backdrop (React-free store).
//
//  While an ELEVATED surface owns the frame (a claims-modal command surface,
//  a quick-open overlay), the retained context around it recedes ONE emphasis
//  step: after compose, every real cell outside the elevated rect(s) has its
//  style remapped toward the family canvas (StylePool.withRecess — derived,
//  cached, idempotent). Geometry, state, scroll and the focus landmark are
//  untouched — colors only.
//
//  POLICY LIVES OUTSIDE: the React side (FullscreenLayout + the theme owner)
//  decides WHEN recess applies (MERCURY_RECESS, color capability, family
//  parseability) by (a) registering elevated surfaces and (b) setting the
//  transform target. This layer only executes: no registrants or no target ⇒
//  the pass is a no-op and costs nothing.
//
//  DAMAGE + BLIT CORRECTNESS: the sweep writes only CHANGED cells through the
//  packed-word path and reports one bbox to the ONE damage tracker, so the
//  activation frame repaints the whole backdrop and steady frames write
//  nothing (already-recessed styles map to themselves — the idempotence law).
//  Deactivation rides the overlay stack's existing invalidatePrevFrame.
// ============================================================================
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

/** Register a mounted elevated-surface node; returns the unregister.
 *
 *  THE UNREGISTER INVALIDATES: deactivation
 *  must never rely on a SIBLING overlay's pop to invalidate. An elevated
 *  Dialog whose Select carries no onCancel registers NO overlay of its own —
 *  its in-flow unmount popped nothing, the un-dirty transcript/rail subtrees
 *  blitted their RECESSED cells forward, and the screen stayed one step
 *  dimmed indefinitely; the NEXT elevation then re-derived recess-of-recess
 *  on those stale cells (a progressive fade across open/close cycles, since
 *  the pool's idempotence set clears with each target change). Unregister
 *  runs at COMMIT time (React calls the old ref with null), BEFORE any
 *  passive effect can null the target — so gating on the live target here
 *  also closes the ansi-theme-flip ordering hole (ref detaches first, the
 *  [t] effect nulls the target after). Blit-free recompose repaints every
 *  cell at true strength. */
export function registerElevatedSurface(el: DOMElement): () => void {
  registrants.add(el)
  return () => {
    registrants.delete(el)
    if (target !== null) {
      instances.get(process.stdout)?.invalidatePrevFrame()
    }
  }
}

/** Set (or clear) the recess target — the theme owner's call. A REAL target
 *  change while surfaces are elevated invalidates the previous frame: the
 *  pool's idempotence set clears with the target, so a blitted OLD-target
 *  recessed cell would otherwise re-derive (recess-of-recess = double-dim).
 *  Blit-free recompose makes the transition exact (the overlay stack's own
 *  close pattern). */
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

/** True while the pass would do work (forensics + tests). */
export function recessActive(): boolean {
  return target !== null && registrants.size > 0
}

/** 3.6.3: the pure elevated-surface fact — a modal/picker/command
 *  overlay is REGISTERED right now, independent of whether the recess visual
 *  is themed on. The alternate-scroll policy reads this (arrows belong to an
 *  open overlay's list navigation, never to transcript scroll). */
export function hasElevatedSurface(): boolean {
  return registrants.size > 0
}

/** The post-compose pass (renderer, alt-screen frames): recess every real
 *  cell outside the committed elevated rects. Returns cells restyled. */
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
  // No elevated surface committed a rect this frame — nothing is genuinely
  // above the context, so nothing recedes (never dim the whole screen).
  if (rects.length === 0) return 0
  stylePool.setRecessTransform(target)
  return remapStylesOutside(screen, rects, id => stylePool.withRecess(id))
}
