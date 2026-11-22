import measureText from './measure-text.js'
import { addPendingClear, nodeCache, noteChildRemoved, setChildReach } from './node-cache.js'
import { createLayoutNode } from './layout/engine.js'
import { LayoutMeasureMode, type LayoutNode } from './layout/node.js'
import type { FocusManager } from './focus.js'
import squashTextNodes from './squash-text-nodes.js'
import type { Color, Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrap-text.js'

export type DOMNodeAttribute = boolean | string | number

type TextName = '#text'
export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-progress'
  | 'ink-raw-ansi'

type ScrollState = {
  scrollTop?: number
  pendingScrollDelta?: number
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  scrollClampGapPrev?: number
  stickyScroll?: boolean
  lastStableAtBottom?: boolean
  scrollAnchor?: { el: DOMElement; offset: number }
}

export type DOMElement = {
  nodeName: ElementNames
  parentNode: DOMElement | undefined
  childNodes: DOMNode[]
  attributes: Record<string, DOMNodeAttribute>
  style: Styles
  dirty: boolean
  textStyles?: TextStyles
  layoutNode?: LayoutNode
  isHidden?: boolean
  scroll?: ScrollState
  _eventHandlers?: Record<string, unknown>
  debugOwnerChain?: string[]
  onRender?: () => void
  onImmediateRender?: () => void
  onComputeLayout?: () => void
  focusManager?: FocusManager
  hasRenderedContent?: boolean
  __prevOwnBg?: Color
  __prevUniformBg?: Color
  __prevOpaque?: boolean
  __prevOwnRowBg?: boolean
  __prevRowSampler?: boolean
}

export type TextNode = {
  nodeName: TextName
  parentNode: DOMElement | undefined
  nodeValue: string
  layoutNode?: undefined
}

export type DOMNode = DOMElement | TextNode

const LAYOUT_LESS_ELEMENTS = new Set<ElementNames>([
  'ink-virtual-text',
  'ink-link',
  'ink-progress',
])

function isElement(node: DOMNode): node is DOMElement {
  return node.nodeName !== '#text'
}

function wrapCells(width: number, widthMode: LayoutMeasureMode): number {
  if (!Number.isFinite(width)) return width
  return widthMode === LayoutMeasureMode.Exactly ? Math.ceil(width) : Math.floor(width)
}

function makeTextMeasureFunc(node: DOMElement) {
  return (width: number, widthMode: LayoutMeasureMode) => {
    const raw = squashTextNodes(node)
    const text = expandTabs(raw)
    const natural = measureText(text, Number.POSITIVE_INFINITY)
    const cells = wrapCells(width, widthMode)
    if (natural.width <= cells) return natural
    if (natural.width >= 1 && width > 0 && width < 1) return natural
    if (text.includes('\n')) {
      if (widthMode === LayoutMeasureMode.Undefined) {
        return measureText(text, Math.max(width, natural.width))
      }
      const textWrap = node.style.textWrap ?? 'wrap'
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) lines[i] = wrapText(lines[i]!, cells, textWrap)
      return measureText(lines.join('\n'), cells)
    }
    const wrapped = wrapText(text, cells, node.style.textWrap ?? 'wrap')
    return measureText(wrapped, cells)
  }
}

function makeRawAnsiMeasureFunc(node: DOMElement) {
  return () => ({
    width: Number(node.attributes['rawWidth'] ?? 0),
    height: Number(node.attributes['rawHeight'] ?? 0),
  })
}

export function createNode(name: ElementNames): DOMElement {
  const node: DOMElement = {
    nodeName: name,
    parentNode: undefined,
    childNodes: [],
    attributes: {},
    style: {},
    dirty: true,
  }
  if (!LAYOUT_LESS_ELEMENTS.has(name)) {
    node.layoutNode = createLayoutNode()
    if (name === 'ink-text') {
      node.layoutNode.setMeasureFunc(makeTextMeasureFunc(node))
    } else if (name === 'ink-raw-ansi') {
      node.layoutNode.setMeasureFunc(makeRawAnsiMeasureFunc(node))
    }
  }
  return node
}

export function createTextNode(text: string): TextNode {
  return {
    nodeName: '#text',
    parentNode: undefined,
    nodeValue: String(text),
  }
}

function layoutIndexFor(parent: DOMElement, domIndex: number): number {
  let index = 0
  for (let i = 0; i < domIndex; i++) {
    const child = parent.childNodes[i]!
    if (isElement(child) && child.layoutNode) index++
  }
  return index
}

export function appendChildNode(parent: DOMElement, child: DOMNode): void {
  if (child.parentNode) removeChildNode(child.parentNode, child)
  child.parentNode = parent
  parent.childNodes.push(child)
  if (isElement(child)) {
    child.dirty = true
    if (child.layoutNode && parent.layoutNode) {
      parent.layoutNode.insertChild(
        child.layoutNode,
        layoutIndexFor(parent, parent.childNodes.length - 1),
      )
    }
  }
  markDirty(parent)
}

export function insertBeforeNode(
  parent: DOMElement,
  newChild: DOMNode,
  beforeChild: DOMNode,
): void {
  if (newChild.parentNode) removeChildNode(newChild.parentNode, newChild)
  const index = parent.childNodes.indexOf(beforeChild)
  if (index === -1) {
    appendChildNode(parent, newChild)
    return
  }
  newChild.parentNode = parent
  parent.childNodes.splice(index, 0, newChild)
  if (isElement(newChild)) {
    newChild.dirty = true
    if (newChild.layoutNode && parent.layoutNode) {
      parent.layoutNode.insertChild(newChild.layoutNode, layoutIndexFor(parent, index))
    }
  }
  markDirty(parent)
}

function queuePaintedClears(parent: DOMElement, node: DOMNode, underAbsolute: boolean): void {
  if (!isElement(node)) return
  const absolute = underAbsolute || node.style.position === 'absolute'
  const painted = nodeCache.get(node)
  if (painted) {
    addPendingClear(parent, painted.reach ?? painted, absolute)
    nodeCache.delete(node)
  } else if (absolute) {
    addPendingClear(parent, { x: 0, y: 0, width: 0, height: 0 }, true)
  }
  for (const child of node.childNodes) queuePaintedClears(parent, child, absolute)
}

export function removeChildNode(parent: DOMElement, node: DOMNode): void {
  queuePaintedClears(parent, node, false)
  if (isElement(node)) {
    setChildReach(parent, node, false)
    if (node.layoutNode && parent.layoutNode) {
      parent.layoutNode.removeChild(node.layoutNode)
      noteChildRemoved(parent)
    }
  }
  node.parentNode = undefined
  const index = parent.childNodes.indexOf(node)
  if (index !== -1) parent.childNodes.splice(index, 1)
  markDirty(parent)
}

export function setAttribute(
  node: DOMElement,
  key: string,
  value: DOMNodeAttribute,
): void {
  if (key === 'children') return
  if (node.attributes[key] === value) return
  node.attributes[key] = value
  markDirty(node)
}

function shallowStyleEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

export function setStyle(node: DOMElement, style: Styles): void {
  if (shallowStyleEqual(node.style, style)) return
  node.style = style
  markDirty(node)
}

export function setTextStyles(node: DOMElement, textStyles: TextStyles): void {
  if (
    shallowStyleEqual(
      node.textStyles as Record<string, unknown> | undefined,
      textStyles as Record<string, unknown>,
    )
  ) {
    return
  }
  node.textStyles = textStyles
  markDirty(node)
}

export function setTextNodeValue(textNode: TextNode, text: string): void {
  const value = typeof text === 'string' ? text : String(text)
  if (textNode.nodeValue === value) return
  textNode.nodeValue = value
  markDirty(textNode)
}

export function markDirty(node?: DOMNode): void {
  let invalidated = false
  let current: DOMNode | undefined = node
  while (current) {
    if (isElement(current)) {
      current.dirty = true
      if (
        !invalidated &&
        current.layoutNode &&
        (current.nodeName === 'ink-text' || current.nodeName === 'ink-raw-ansi')
      ) {
        current.layoutNode.markDirty()
        invalidated = true
      }
    }
    current = current.parentNode
  }
}

export function scheduleRenderFrom(node?: DOMNode): void {
  let current: DOMNode | undefined = node
  while (current?.parentNode) current = current.parentNode
  if (current && isElement(current)) current.onRender?.()
}

export function clearLayoutNodeReferences(node: DOMNode): void {
  if (!isElement(node)) return
  node.layoutNode = undefined
  for (const child of node.childNodes) clearLayoutNodeReferences(child)
}

function ownerChainAtRow(node: DOMElement, y: number, parentTop: number, found: string[]): string[] {
  if (node.style.display === 'none' || !node.layoutNode) return found
  const top = parentTop + node.layoutNode.getComputedTop()
  let chain = found
  if (node.debugOwnerChain && y >= top && y < top + node.layoutNode.getComputedHeight()) chain = node.debugOwnerChain
  for (const child of node.childNodes) {
    if (isElement(child)) chain = ownerChainAtRow(child, y, top, chain)
  }
  return chain
}

export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  return ownerChainAtRow(root, y, 0, [])
}
