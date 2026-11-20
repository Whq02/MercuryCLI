import { logError } from '../../utils/log.js'
import { colorize } from '../colorize.js'
import type { DOMElement } from '../dom.js'
import type { EventHandlerProps } from '../events/event-handlers.js'
import { hitTest } from '../geometry/hit.js'
import { clearSelection, setSelectionClipBand, startSelection, selectWordAt, selectLineAt, extendSelection, updateSelection, type FocusMove, moveFocus, hasSelection, getSelectedText, type Point } from '../geometry/selection.js'
import { nodeCache } from '../node-cache.js'
import { termWrite } from '../terminalOut.js'
import { setClipboard } from '../termio/osc.js'
import type Ink from '../ink.js'

function samePoint(a: Point | null, b: Point | null): boolean {
  return a === b || (a !== null && b !== null && a.col === b.col && a.row === b.row)
}

export function notifySelectionChange(this: Pick<Ink, 'selectionListeners' | 'onRender'>): void {
  this.onRender()
  for (const listener of this.selectionListeners) listener()
}

export function subscribeToSelectionChange(this: Pick<Ink, 'selectionListeners'>, callback: () => void): () => void {
  this.selectionListeners.add(callback)
  return () => {
    this.selectionListeners.delete(callback)
  }
}

function applySelectionClipBand(this: Pick<Ink, 'frontFrame' | 'rootNode' | 'selection'>, col: number, row: number): void {
  try {
    const hit = hitTest(this.rootNode, col, row)
    let owner: DOMElement | null = null
    let node: DOMElement | undefined = hit ?? undefined
    while (node) {
      if (node.scroll?.scrollTop !== undefined || node.scroll?.scrollHeight !== undefined) {
        owner = node
        break
      }
      node = node.parentNode
    }
    const region = owner ?? hit
    const rect = region ? nodeCache.get(region) : undefined
    if (!rect) {
      clearSelection(this.selection)
      return
    }
    setSelectionClipBand(
      this.selection,
      rect.x,
      rect.x + rect.width - 1,
      this.frontFrame.screen.width,
      rect.y,
      rect.y + rect.height - 1,
      this.frontFrame.screen.height,
    )
  } catch {
    clearSelection(this.selection)
  }
}

function offerTextGesture(this: Pick<Ink, 'rootNode' | 'textGesture'>, col: number, row: number, clickCount: 1 | 2 | 3): boolean {
  this.textGesture = null
  let node: DOMElement | undefined = hitTest(this.rootNode, col, row) ?? undefined
  while (node) {
    const handler = (node._eventHandlers as EventHandlerProps | undefined)?.onTextGesture
    if (handler) {
      const rect = nodeCache.get(node)
      if (!rect) return false
      const claimed =
        handler({ kind: 'press', localCol: col - rect.x, localRow: row - rect.y, clickCount }) === true
      if (claimed) this.textGesture = { handler, rect }
      return claimed
    }
    node = node.parentNode
  }
  return false
}

function textGestureTookPress(this: Pick<Ink, 'selection' | 'notifySelectionChange'>): void {
  if (this.selection.anchor === null) return
  clearSelection(this.selection)
  this.notifySelectionChange()
}

export function handleSelectionStart(this: Pick<Ink, 'frontFrame' | 'rootNode' | 'altScreenActive' | 'selection' | 'textGesture' | 'notifySelectionChange'>, col: number, row: number, pressHadAlt: boolean): void {
  if (!this.altScreenActive) return
  if (offerTextGesture.call(this, col, row, 1)) {
    textGestureTookPress.call(this)
    return
  }
  startSelection(this.selection, col, row)
  this.selection.lastPressHadAlt = pressHadAlt
  applySelectionClipBand.call(this, col, row)
  this.notifySelectionChange()
}

export function handleMultiClick(this: Pick<Ink, 'frontFrame' | 'rootNode' | 'altScreenActive' | 'selection' | 'textGesture' | 'notifySelectionChange'>, col: number, row: number, count: 2 | 3): void {
  if (!this.altScreenActive) return
  if (offerTextGesture.call(this, col, row, count)) {
    textGestureTookPress.call(this)
    return
  }
  startSelection(this.selection, col, row)
  applySelectionClipBand.call(this, col, row)
  const screen = this.frontFrame.screen
  if (count === 2) selectWordAt(this.selection, screen, col, row)
  else selectLineAt(this.selection, screen, row)
  if (this.selection.focus === null && this.selection.anchor) {
    this.selection.focus = { ...this.selection.anchor }
  }
  this.notifySelectionChange()
}

export function handleSelectionDrag(this: Pick<Ink, 'frontFrame' | 'altScreenActive' | 'selection' | 'textGesture' | 'notifySelectionChange'>, col: number, row: number): void {
  if (!this.altScreenActive) return
  if (this.textGesture) {
    const { handler, rect } = this.textGesture
    handler({ kind: 'drag', localCol: col - rect.x, localRow: row - rect.y, clickCount: 1 })
    return
  }
  const s = this.selection
  const anchor = s.anchor
  const focus = s.focus
  if (s.anchorSpan) {
    extendSelection(s, this.frontFrame.screen, col, row)
  } else {
    updateSelection(s, col, row)
  }
  if (samePoint(s.anchor, anchor) && samePoint(s.focus, focus)) return
  this.notifySelectionChange()
}

export function handleSelectionRelease(this: Pick<Ink, 'textGesture'>, col: number, row: number): boolean {
  const gesture = this.textGesture
  if (!gesture) return false
  this.textGesture = null
  gesture.handler({ kind: 'release', localCol: col - gesture.rect.x, localRow: row - gesture.rect.y, clickCount: 1 })
  return true
}

export function moveSelectionFocus(this: Pick<Ink, 'frontFrame' | 'altScreenActive' | 'selection' | 'notifySelectionChange'>, move: FocusMove): void {
  if (!this.altScreenActive) return
  const focus = this.selection.focus
  if (!focus) return
  const width = this.frontFrame.screen.width
  const height = this.frontFrame.screen.height
  let { col, row } = focus
  switch (move) {
    case 'left':
      if (col > 0) col--
      else if (row > 0) {
        row--
        col = width - 1
      }
      break
    case 'right':
      if (col < width - 1) col++
      else if (row < height - 1) {
        row++
        col = 0
      }
      break
    case 'up':
      row = Math.max(0, row - 1)
      break
    case 'down':
      row = Math.min(height - 1, row + 1)
      break
    case 'lineStart':
      col = 0
      break
    case 'lineEnd':
      col = width - 1
      break
  }
  if (col === focus.col && row === focus.row) return
  moveFocus(this.selection, col, row)
  this.notifySelectionChange()
}

export function copySelectionNoClear(this: Pick<Ink, 'options' | 'frontFrame' | 'selection'>): string {
  if (!hasSelection(this.selection)) return ''
  const text = getSelectedText(this.selection, this.frontFrame.screen)
  if (text) {
    void setClipboard(text)
      .then(sequence => {
        if (sequence) termWrite(this.options.stdout, sequence)
      })
      .catch(logError)
  }
  return text
}

export function copySelection(this: Pick<Ink, 'selection' | 'notifySelectionChange' | 'copySelectionNoClear'>): string {
  if (!hasSelection(this.selection)) return ''
  const text = this.copySelectionNoClear()
  clearSelection(this.selection)
  this.notifySelectionChange()
  return text
}

export function copyText(this: Pick<Ink, 'options'>, text: string): void {
  if (!text) return
  void setClipboard(text)
    .then(sequence => {
      if (sequence) termWrite(this.options.stdout, sequence)
    })
    .catch(logError)
}

export function clearTextSelection(this: Pick<Ink, 'selection' | 'notifySelectionChange'>): void {
  if (!hasSelection(this.selection)) return
  clearSelection(this.selection)
  this.notifySelectionChange()
}

export function setSelectionBgColor(this: Pick<Ink, 'stylePool'>, color: string): void {
  const marker = '\0'
  const painted = colorize(marker, color, 'background')
  const index = painted.indexOf(marker)
  if (index <= 0 || index >= painted.length - 1) {
    this.stylePool.setSelectionBg(null)
    return
  }
  this.stylePool.setSelectionBg({
    type: 'ansi',
    code: painted.slice(0, index),
    endCode: painted.slice(index + 1),
  })
}
