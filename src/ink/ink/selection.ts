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
import { notBuilt } from '../../pi/holes.js'

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

export function handleSelectionStart(this: Pick<Ink, 'frontFrame' | 'rootNode' | 'altScreenActive' | 'selection' | 'textGesture' | 'notifySelectionChange'>, col: number, row: number, pressHadAlt: boolean): void {
  return notBuilt('src/ink/ink/selection.ts:84')
}

export function handleMultiClick(this: Pick<Ink, 'frontFrame' | 'rootNode' | 'altScreenActive' | 'selection' | 'textGesture' | 'notifySelectionChange'>, col: number, row: number, count: 2 | 3): void {
  return notBuilt('src/ink/ink/selection.ts:96')
}

export function handleSelectionDrag(this: Pick<Ink, 'frontFrame' | 'altScreenActive' | 'selection' | 'textGesture' | 'notifySelectionChange'>, col: number, row: number): void {
  return notBuilt('src/ink/ink/selection.ts:113')
}

export function handleSelectionRelease(this: Pick<Ink, 'textGesture'>, col: number, row: number): boolean {
  const gesture = this.textGesture
  if (!gesture) return false
  this.textGesture = null
  gesture.handler({ kind: 'release', localCol: col - gesture.rect.x, localRow: row - gesture.rect.y, clickCount: 1 })
  return true
}

export function moveSelectionFocus(this: Pick<Ink, 'frontFrame' | 'altScreenActive' | 'selection' | 'notifySelectionChange'>, move: FocusMove): void {
  return notBuilt('src/ink/ink/selection.ts:140')
}

export function copySelectionNoClear(this: Pick<Ink, 'options' | 'frontFrame' | 'selection'>): string {
  return notBuilt('src/ink/ink/selection.ts:180')
}

export function copySelection(this: Pick<Ink, 'selection' | 'notifySelectionChange' | 'copySelectionNoClear'>): string {
  return notBuilt('src/ink/ink/selection.ts:193')
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
  return notBuilt('src/ink/ink/selection.ts:210')
}

export function setSelectionBgColor(this: Pick<Ink, 'stylePool'>, color: string): void {
  return notBuilt('src/ink/ink/selection.ts:216')
}
