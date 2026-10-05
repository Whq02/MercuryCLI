import type { DOMElement } from '../dom.js'
import { ClickEvent } from '../events/click-event.js'
import type { EventHandlerProps } from '../events/event-handlers.js'
import { committedRects, type RectIndex } from './rect-index.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

function* parentChain(node: DOMElement | null): Generator<DOMElement> {
  for (let current: DOMElement | undefined = node ?? undefined; current; current = current.parentNode) yield current
}

export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
  rects: RectIndex = committedRects,
): DOMElement | null {
  const box = rects.get(node)
  if (!box || col < box.x || row < box.y || col >= box.x + box.width || row >= box.y + box.height) return null
  let index = node.childNodes.length
  while (index > 0) {
    const child = node.childNodes[--index]!
    if (child.nodeName !== '#text') {
      const found = hitTest(child, col, row, rects)
      if (found) return found
    }
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
  } catch {}
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
    for (const candidate of parentChain(target)) {
      if (typeof candidate.attributes['tabIndex'] !== 'number') continue
      root.focusManager.handleClickFocus(candidate)
      break
    }
  }
  const event = new ClickEvent(col, row, cellIsBlank)
  let handled = false
  for (const recipient of parentChain(target)) {
    const handler = recipient._eventHandlers?.onClick as ((event: ClickEvent) => void) | undefined
    if (!handler) continue
    handled = true
    const box = rects.get(recipient)
    if (box) {
      event.localCol = col - box.x
      event.localRow = row - box.y
    }
    handler(event)
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
  const next = new Set<DOMElement>()
  for (const candidate of parentChain(hitTest(root, col, row, rects))) {
    const handlers = candidate._eventHandlers as EventHandlerProps | undefined
    if (handlers?.onMouseEnter || handlers?.onMouseLeave) next.add(candidate)
  }
  for (const previous of hovered) {
    if (next.has(previous)) continue
    hovered.delete(previous)
    if (previous.parentNode) (previous._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
  }
  for (const current of next) {
    if (hovered.has(current)) continue
    hovered.add(current)
    ;(current._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
  }
}
