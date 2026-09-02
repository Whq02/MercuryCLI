// ============================================================================
//  overlayStack — the overlay OWNERSHIP stack.
//
//  Replaces the AppState `activeOverlays: Set<string>` membership model,
//  whose two structural failures were:
//    1. DUPLICATE SEMANTIC IDS COLLIDED — two mounted overlays with the same
//       id ('select' under a dialog beside another 'select'; the two
//       'quick-open' components) shared ONE set slot: the second mount
//       no-op'ed the add, the first unmount deleted it, and the surviving
//       overlay believed it was registered while the set said otherwise.
//    2. NO ORDER — a Set knows "something is open", never WHICH overlay is
//       on top, so Escape and modal keys had no ownership answer and every
//       stacked pair double-handled input.
//
//  This store tracks INSTANCES: every registration gets a unique token and
//  a stack position (push order == z-order). Semantic ids remain for
//  policy (NON_MODAL_OVERLAYS) and forensics, but identity is the token.
//
//  ESCAPE CLOSES ONE LAYER — mechanically: handlers ask isTopOverlayNow()
//  before acting on esc, and pop() stamps the input-event seq that closed a
//  layer. A later-dispatched handler in the SAME event sees the stamp and
//  stands down, so one Escape can never cascade through two layers even
//  though the first pop makes the second overlay "top" mid-dispatch.
//
//  FOCUS RETURN — an entry may carry onFocusReturn (the opener's restore:
//  prompt cursor, pane focus). It runs when that entry is popped while
//  being the visually-top layer (closing a buried layer must not steal
//  focus back).
//
//  No React, no I/O, module-scoped; UI hooks live in overlayContext.tsx.
// ============================================================================

import { currentInputEventSeq } from '../ink/events/input-event.js'

export interface OverlayEntry {
  readonly token: number
  readonly id: string
  readonly modal: boolean
  /** Input-event seq current when the overlay opened (forensics). */
  readonly openSeq: number
  /** Opener focus restore — runs on pop iff this entry is top. */
  readonly onFocusReturn?: () => void
  /** This overlay renders a REAL paged viewport and owns PageUp/PageDown
   *  while it is top (MINI-TEMPER item 2): the transcript scroller yields
   *  page keys to it instead of scrolling behind the modal. */
  readonly ownsPageKeys?: boolean
}

let stack: OverlayEntry[] = []
let version = 0
let nextToken = 1
/** The input-event seq during which a layer was last popped — the
 *  one-pop-per-event cap for esc routing. */
let lastPopEventSeq = -1
const listeners = new Set<() => void>()

function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* a throwing subscriber never blocks the others */
    }
  }
}

/** Reserve a stable instance token BEFORE registration — the React hook
 *  allocates it at first render (useState initializer) so input handlers
 *  close over a real token from the start; the layout effect then pushes
 *  under it. */
export function reserveOverlayToken(): number {
  return nextToken++
}

export function pushOverlay(entry: {
  id: string
  modal: boolean
  token?: number
  onFocusReturn?: () => void
  ownsPageKeys?: boolean
}): number {
  const token = entry.token ?? nextToken++
  // Re-push under a held token replaces the old entry (StrictMode double
  // mount, enabled flicker) instead of stacking a duplicate.
  const withoutDup = stack.filter(e => e.token !== token)
  stack = [
    ...withoutDup,
    {
      token,
      id: entry.id,
      modal: entry.modal,
      openSeq: currentInputEventSeq(),
      onFocusReturn: entry.onFocusReturn,
      ownsPageKeys: entry.ownsPageKeys,
    },
  ]
  bump()
  return token
}

export function popOverlay(token: number): void {
  const idx = stack.findIndex(e => e.token === token)
  if (idx === -1) return
  const wasTop = idx === stack.length - 1
  const entry = stack[idx]!
  stack = [...stack.slice(0, idx), ...stack.slice(idx + 1)]
  lastPopEventSeq = currentInputEventSeq()
  bump()
  if (wasTop && entry.onFocusReturn) {
    try {
      entry.onFocusReturn()
    } catch {
      /* focus restore is best-effort — never break the close */
    }
  }
}

export function overlayStackVersion(): number {
  return version
}

export function subscribeOverlayStack(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function overlayStackSnapshot(): readonly OverlayEntry[] {
  return stack
}

export function anyOverlayActive(): boolean {
  return stack.length > 0
}

export function anyModalOverlayActive(): boolean {
  return stack.some(e => e.modal)
}

export function topOverlay(): OverlayEntry | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null
}

/** True while the visually-top overlay declared page-key ownership — the
 *  transcript scroller asks this to YIELD PageUp/PageDown to the overlay's
 *  own pager (one key, one owner; MINI-TEMPER item 2). */
export function topOverlayOwnsPageKeys(): boolean {
  return topOverlay()?.ownsPageKeys === true
}

/**
 * True when `token` is the top of the stack AND no layer has already been
 * popped during the currently-dispatching input event. Non-reactive by
 * design — call from input handlers at dispatch time. (For render-time
 * reactivity use useOverlayIsTop.)
 */
export function isTopOverlayNow(token: number): boolean {
  if (lastPopEventSeq === currentInputEventSeq() && lastPopEventSeq !== -1) {
    return false
  }
  const top = topOverlay()
  return top !== null && top.token === token
}

/** Test/proof seam — clears the stack and the pop stamp. */
export function resetOverlayStackForTests(): void {
  stack = []
  lastPopEventSeq = -1
  bump()
}
