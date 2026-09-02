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
    }
  }
  if (!target) return false

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
