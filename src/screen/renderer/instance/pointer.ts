import { applyPointerShape } from '../../cockpit/pointerShape.js'
import { cellAt, CellWidth, isInklessCellAt, inkFlanksCellAt, isEmptyCellAt } from '../cell-grid.js'
import { KeyboardEvent } from '../events/keyboard-event.js'
import { dispatchClick as dispatchClickInTree, hitTest, dispatchHover as dispatchHoverInTree } from '../geometry/hitTest.js'
import { findPlainTextUrlAt } from '../geometry/selection.js'
import type { ParsedKey } from '../input/input-decoder.js'
import { nodeCache } from '../node-cache.js'
import { dispatcher } from '../reconciler.js'
import { termWrite } from '../terminalOut.js'
import type Ink from '../screenInstance.js'

export function getHyperlinkAt(this: Pick<Ink, 'frontFrame' | 'altScreenActive'>, col: number, row: number): string | undefined {
  if (!this.altScreenActive) return undefined
  const screen = this.frontFrame.screen
  const cell = cellAt(screen, col, row)
  if (cell?.hyperlink) return cell.hyperlink
  if (cell?.width === CellWidth.SpacerTail && col > 0) {
    const head = cellAt(screen, col - 1, row)
    if (head?.hyperlink) return head.hyperlink
  }
  return findPlainTextUrlAt(screen, col, row)
}

export function dispatchClick(this: Pick<Ink, 'stylePool' | 'frontFrame' | 'rootNode' | 'altScreenActive'>, col: number, row: number): boolean {
  if (!this.altScreenActive) return false
  return dispatchClickInTree(this.rootNode, col, row, pointerOnBlank.call(this, col, row))
}

function pointerOnBlank(this: Pick<Ink, 'stylePool' | 'frontFrame' | 'rootNode'>, col: number, row: number): boolean {
  const screen = this.frontFrame.screen
  if (!isInklessCellAt(screen, col, row, this.stylePool)) return false
  const hit = hitTest(this.rootNode, col, row)
  const box = hit === null ? undefined : nodeCache.get(hit)
  return box === undefined || !inkFlanksCellAt(screen, col, row, Math.floor(box.x), Math.floor(box.x + box.width), this.stylePool)
}

export function dispatchHover(this: Pick<Ink, 'options' | 'frontFrame' | 'rootNode' | 'altScreenActive' | 'hoveredNodes'>, col: number, row: number): void {
  if (!this.altScreenActive) return
  const screen = this.frontFrame.screen
  const selectable =
    col >= 0 &&
    row >= 0 &&
    col < screen.width &&
    row < screen.height &&
    screen.noSelect[row * screen.width + col] !== 1 &&
    !isEmptyCellAt(screen, col, row)
  applyPointerShape(selectable, s => termWrite(this.options.stdout, s))
  dispatchHoverInTree(this.rootNode, col, row, this.hoveredNodes)
}

export function dispatchKeyboardEvent(this: Pick<Ink, 'rootNode' | 'focusManager'>, parsedKey: ParsedKey): void {
  const target = this.focusManager.activeElement ?? this.rootNode
  const event = new KeyboardEvent(parsedKey)
  const notPrevented = dispatcher.dispatchDiscrete(target, event)
  if (notPrevented && event.key === 'tab' && !event.ctrl && !event.meta) {
    if (event.shift) this.focusManager.focusPrevious(this.rootNode)
    else this.focusManager.focusNext(this.rootNode)
  }
}
