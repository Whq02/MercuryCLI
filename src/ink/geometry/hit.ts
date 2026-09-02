// ============================================================================
//  hit.ts — T7: pointer → node resolution + dispatch.
//
//  The contract (prove-geometry-contract DISPATCH · HIT GEOMETRY · HOVER +
//  prove-hit-map's containment/topmost/stale-rect sweeps):
//
//  • hitTest resolves the DEEPEST element whose committed rect contains the
//    cell. Children traverse in REVERSE — later siblings paint on top, so
//    the topmost painted node wins. A node absent from the rect index (not
//    rendered this frame, or layout-less) prunes its whole subtree; the
//    PARENT-RECT GATE means a child painted outside its parent's rect is
//    unreachable (containment is checked at every level on the way down).
//  • dispatchClick focuses the closest tabIndex ancestor of the hit (the
//    root's FocusManager owns click-focus), then bubbles ONE ClickEvent up
//    the parent chain: only onClick holders fire; each handler sees
//    localCol/localRow rebased against ITS OWN committed rect;
//    stopImmediatePropagation halts the walk; the return says whether any
//    handler fired.
//  • dispatchHover implements DOM mouseenter/mouseleave semantics —
//    NON-bubbling: the hovered set is the hit node's ancestor chain
//    filtered to hover-handler holders; the set DIFF fires leave on exits
//    (skipped for detached nodes, membership still dropped) and enter on
//    entries. The caller owns the set across events; a null hit clears it.
// ============================================================================
import type { DOMElement } from '../dom.js'
import { ClickEvent } from '../events/click-event.js'
import type { EventHandlerProps } from '../events/event-handlers.js'
import { committedRects, type RectIndex } from './rect-index.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
  rects: RectIndex = committedRects,
): DOMElement | null {
  const rect = rects.get(node)
  if (!rect) return null
  if (
    col < rect.x ||
    col >= rect.x + rect.width ||
    row < rect.y ||
    row >= rect.y + rect.height
  ) {
    return null
  }
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const hit = hitTest(child, col, row, rects)
    if (hit) return hit
  }
  return node
}

export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
  rects: RectIndex = committedRects,
): boolean {
  let target: DOMElement | undefined = hitTest(root, col, row, rects) ?? undefined
  // Debug seam: MERCURY_CLICK_DEBUG=<file> appends the resolved
  // hit chain per click — the instrument that found the dead-click class
  // (clicks swallowed above the transcript tail). File-target only: stderr
  // would interleave into the PTY stream and corrupt captures.
  const dbg = flagEnv('MERCURY_CLICK_DEBUG')
  if (dbg) {
    try {
      const chain: string[] = []
      let n: DOMElement | undefined = target
      while (n) {
        const r = rects.get(n)
        chain.push(
          `${n.nodeName}${n.attributes['tabIndex'] !== undefined ? '[tab]' : ''}${(n._eventHandlers as { onClick?: unknown } | undefined)?.onClick ? '[onClick]' : ''}${r ? `@${r.x},${r.y},${r.width}x${r.height}` : '@norect'}`,
        )
        n = n.parentNode
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
        dbg,
        `click ${col},${row} blank=${cellIsBlank} target=${target ? 'hit' : 'MISS'} chain=${chain.join(' > ') || '(none)'}\n`,
      )
    } catch {
      /* debug only */
    }
  }
  if (!target) return false

  // Click-to-focus: the closest focusable ancestor takes focus (root is
  // always ink-root, which owns the FocusManager).
  if (root.focusManager) {
    let focusTarget: DOMElement | undefined = target
    while (focusTarget) {
      if (typeof focusTarget.attributes['tabIndex'] === 'number') {
        root.focusManager.handleClickFocus(focusTarget)
        break
      }
      focusTarget = focusTarget.parentNode
    }
  }

  const event = new ClickEvent(col, row, cellIsBlank)
  let handled = false
  while (target) {
    const handler = target._eventHandlers?.onClick as
      | ((event: ClickEvent) => void)
      | undefined
    if (handler) {
      handled = true
      const rect = rects.get(target)
      if (rect) {
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      }
      handler(event)
      if (event.didStopImmediatePropagation()) return true
    }
    target = target.parentNode
  }
  return handled
}

export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
  rects: RectIndex = committedRects,
): void {
  const next = new Set<DOMElement>()
  let node: DOMElement | undefined = hitTest(root, col, row, rects) ?? undefined
  while (node) {
    const h = node._eventHandlers as EventHandlerProps | undefined
    if (h?.onMouseEnter || h?.onMouseLeave) next.add(node)
    node = node.parentNode
  }
  for (const old of hovered) {
    if (!next.has(old)) {
      hovered.delete(old)
      // A node removed between mouse events gets no leave call — but its
      // membership drops so a re-mount re-enters cleanly.
      if (old.parentNode) {
        ;(old._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
      }
    }
  }
  for (const n of next) {
    if (!hovered.has(n)) {
      hovered.add(n)
      ;(n._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
    }
  }
}
