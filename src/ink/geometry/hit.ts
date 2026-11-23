import type { DOMElement } from '../dom.js'
import { ClickEvent } from '../events/click-event.js'
import type { EventHandlerProps } from '../events/event-handlers.js'
import { committedRects, type RectIndex } from './rect-index.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { passedOver } from '../../utils/passedOver.js'

function* parentChain(node: DOMElement | null): Generator<DOMElement> {
  for (let current: DOMElement | undefined = node ?? undefined; current; current = current.parentNode) yield current
}

export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
  rects: RectIndex = committedRects,
): DOMElement | null {
  const rect = rects.get(node)
  if (!rect) return null
  if (col < rect.x || col >= rect.x + rect.width || row < rect.y || row >= rect.y + rect.height) {
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

function recordClickHit(target: DOMElement | null, col: number, row: number, cellIsBlank: boolean, rects: RectIndex): void {
  const dbg = flagEnv('MERCURY_CLICK_DEBUG')
  if (!dbg) return
  try {
    const chain: string[] = []
    for (const n of parentChain(target)) {
      const r = rects.get(n)
      chain.push(
        `${n.nodeName}${n.attributes['tabIndex'] !== undefined ? '[tab]' : ''}${(n._eventHandlers as { onClick?: unknown } | undefined)?.onClick ? '[onClick]' : ''}${r ? `@${r.x},${r.y},${r.width}x${r.height}` : '@norect'}`,
      )
    }
    ;(require('node:fs') as typeof import('node:fs')).appendFileSync(
      dbg,
      `click ${col},${row} blank=${cellIsBlank} target=${target ? 'hit' : 'MISS'} chain=${chain.join(' > ') || '(none)'}\n`,
    )
  } catch (error) { passedOver(error) }
}

export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
  rects: RectIndex = committedRects,
): boolean {
  const target = hitTest(root, col, row, rects)
  recordClickHit(target, col, row, cellIsBlank, rects)
  if (!target) return false
  if (root.focusManager) {
    for (const ancestor of parentChain(target)) {
      if (typeof ancestor.attributes['tabIndex'] === 'number') {
        root.focusManager.handleClickFocus(ancestor)
        break
      }
    }
  }
  const event = new ClickEvent(col, row, cellIsBlank)
  let handled = false
  for (const ancestor of parentChain(target)) {
    const onClick = (ancestor._eventHandlers as EventHandlerProps | undefined)?.onClick
    if (!onClick) continue
    handled = true
    const box = rects.get(ancestor)
    if (box) {
      event.localCol = col - box.x
      event.localRow = row - box.y
    }
    onClick(event)
    if (event.didStopImmediatePropagation()) break
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
  const target = hitTest(root, col, row, rects)
  const next = new Set<DOMElement>()
  for (const ancestor of parentChain(target)) {
    const handlers = ancestor._eventHandlers as EventHandlerProps | undefined
    if (handlers?.onMouseEnter || handlers?.onMouseLeave) next.add(ancestor)
  }
  for (const previous of [...hovered]) {
    if (next.has(previous)) continue
    hovered.delete(previous)
    if (previous.parentNode) {
      ;(previous._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
    }
  }
  for (const current of next) {
    if (hovered.has(current)) continue
    hovered.add(current)
    ;(current._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
  }
}
