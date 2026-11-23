import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { createScreen } from '../cell-grid.js'
import ComposeBuffer from '../compose-buffer.js'
import composeTree from '../compose-walk.js'
import { type DOMElement, markDirty } from '../dom.js'
import { type MatchPosition, scanPositions } from '../matchPositions.js'
import type { SearchPositions } from '../root/overlay-pass.js'
import type ScreenInstance from '../screenInstance.js'

export function setSearchHighlight(this: Pick<ScreenInstance, 'searchQuery' | 'scheduleRender'>, query: string): void {
  if (query === this.searchQuery) return
  this.searchQuery = query
  this.scheduleRender()
}

export function setSearchPositions(this: Pick<ScreenInstance, 'searchPositions' | 'scheduleRender'>, state: SearchPositions | null): void {
  this.searchPositions = state
  this.scheduleRender()
}

export function scanElementSubtree(this: Pick<ScreenInstance, 'stylePool' | 'charPool' | 'hyperlinkPool' | 'searchQuery'>, el: DOMElement): MatchPosition[] {
  if (!this.searchQuery) return []
  const layout = el.layoutNode
  if (!layout) return []
  const width = Math.ceil(layout.getComputedWidth())
  const height = Math.ceil(layout.getComputedHeight())
  if (width <= 0 || height <= 0) return []
  const screen = createScreen(width, height, this.stylePool, this.charPool, this.hyperlinkPool)
  const buffer = new ComposeBuffer({ width, height, stylePool: this.stylePool, screen })
  composeTree(el, buffer, {
    offsetX: -layout.getComputedLeft(),
    offsetY: -layout.getComputedTop(),
    prevScreen: undefined,
  })
  const composed = buffer.get()
  markDirty(el)
  const positions = scanPositions(composed, this.searchQuery)
  logForDebugging(
    `scanElementSubtree: query=${JSON.stringify(this.searchQuery)} ${width}x${height} matches=${positions.length} first=${JSON.stringify(positions.slice(0, 3))}`,
  )
  return positions
}
