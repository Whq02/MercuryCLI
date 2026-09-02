
import measureText from './measure-text.js'
import { addPendingClear, nodeCache } from './node-cache.js'
import { createLayoutNode } from './layout/engine.js'
import { LayoutMeasureMode, type LayoutNode } from './layout/node.js'
import type { FocusManager } from './focus.js'
import squashTextNodes from './squash-text-nodes.js'
import type { Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrap-text.js'

export type DOMNodeAttribute = boolean | string | number

export type TextName = '#text'
export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-progress'
  | 'ink-raw-ansi'
export type NodeNames = ElementNames | TextName

export type ScrollState = {
  scrollTop?: number
  pendingScrollDelta?: number
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  scrollAnchor?: { el: DOMElement; offset: number }
  scrollClampGapPrev?: number
  lastStableAtBottom?: boolean
}

export type DOMElement = {
  nodeName: ElementNames
  parentNode: DOMElement | undefined
  childNodes: DOMNode[]
  attributes: Record<string, DOMNodeAttribute>
  style: Styles
  textStyles?: TextStyles
  layoutNode?: LayoutNode
  dirty: boolean
  isHidden?: boolean
  scroll?: ScrollState
  _eventHandlers?: Record<string, unknown>
  debugOwnerChain?: string[]
  onRender?: () => void
  onImmediateRender?: () => void
  onComputeLayout?: () => void
  focusManager?: FocusManager
  hasRenderedContent?: boolean
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

function makeTextMeasureFunc(node: DOMElement) {
  return (width: number, widthMode: LayoutMeasureMode) => {
    const raw = squashTextNodes(node)
    const text = expandTabs(raw)
    const natural = measureText(text, Number.POSITIVE_INFINITY)
    if (natural.width <= width) return natural
    if (natural.width >= 1 && width > 0 && width < 1) return natural
    if (text.includes('\n')) {
      if (widthMode === LayoutMeasureMode.Undefined) {
        return measureText(text, Math.max(width, natural.width))
      }
      const textWrap = node.style.textWrap ?? 'wrap'
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) lines[i] = wrapText(lines[i]!, width, textWrap)
      return measureText(lines.join('\n'), width)
    }
    const wrapped = wrapText(text, width, node.style.textWrap ?? 'wrap')
    return measureText(wrapped, width)
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
  if (isElement(child) && child.layoutNode && parent.layoutNode) {
    parent.layoutNode.insertChild(
      child.layoutNode,
      layoutIndexFor(parent, parent.childNodes.length - 1),
    )
  }
  markDirty(parent)
}

export function insertBeforeNode(
  parent: DOMElement,
  newChild: DOMNode,
  beforeChild: DOMNode,
): void {
  if (newChild.parentNode) removeChildNode(newChild.parentNode, newChild)
  const referenceIndex = parent.childNodes.indexOf(beforeChild)
  if (referenceIndex === -1) {
    appendChildNode(parent, newChild)
    return
  }
  newChild.parentNode = parent
  parent.childNodes.splice(referenceIndex, 0, newChild)
  if (isElement(newChild) && newChild.layoutNode && parent.layoutNode) {
    parent.layoutNode.insertChild(
      newChild.layoutNode,
      layoutIndexFor(parent, referenceIndex),
    )
  }
  markDirty(parent)
}

function collectRemovalRects(
  parent: DOMElement,
  node: DOMNode,
  inheritedAbsolute: boolean,
): void {
  if (!isElement(node)) return
  const absolute = inheritedAbsolute || node.style.position === 'absolute'
  const rect = nodeCache.get(node)
  if (rect) {
    addPendingClear(parent, rect, absolute)
    nodeCache.delete(node)
  } else if (absolute) {
    addPendingClear(parent, { x: 0, y: 0, width: 0, height: 0 }, true)
  }
  for (const child of node.childNodes) {
    collectRemovalRects(parent, child, absolute)
  }
}

export function removeChildNode(parent: DOMElement, node: DOMNode): void {
  collectRemovalRects(parent, node, false)
  if (isElement(node) && node.layoutNode && parent.layoutNode) {
    parent.layoutNode.removeChild(node.layoutNode)
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
  if (!a || !b) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export function setStyle(node: DOMElement, style: Styles): void {
  if (shallowStyleEqual(node.style as Record<string, unknown>, style as Record<string, unknown>)) {
    return
  }
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
  for (const child of node.childNodes) {
    clearLayoutNodeReferences(child)
  }
}

export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  let captured: string[] | undefined

  const visit = (node: DOMNode, offsetY: number): void => {
    if (!isElement(node)) return
    if (node.style.display === 'none') return
    const layout = node.layoutNode
    if (!layout) return
    const top = offsetY + layout.getComputedTop()
    const height = layout.getComputedHeight()
    if (y >= top && y < top + height && node.debugOwnerChain) {
      captured = node.debugOwnerChain
    }
    for (const child of node.childNodes) {
      visit(child, top)
    }
  }

  visit(root, 0)
  return captured ?? []
}
