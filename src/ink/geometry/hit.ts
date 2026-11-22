import type { DOMElement } from '../dom.js'
import { ClickEvent } from '../events/click-event.js'
import type { EventHandlerProps } from '../events/event-handlers.js'
import { committedRects, type RectIndex } from './rect-index.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

function* parentChain(node: DOMElement | null): Generator<DOMElement> {
  for (let current: DOMElement | undefined = node ?? undefined; current; current = current.parentNode) yield current
}

export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
  rects?: RectIndex,
): DOMElement | null {
  return notBuilt('src/ink/geometry/hit.ts:12')
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
  cellIsBlank?: boolean,
  rects?: RectIndex,
): boolean {
  return notBuilt('src/ink/geometry/hit.ts:49')
}

export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
  rects?: RectIndex,
): void {
  return notBuilt('src/ink/geometry/hit.ts:83')
}
