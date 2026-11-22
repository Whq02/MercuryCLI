import measureText from './measure-text.js'
import { addPendingClear, nodeCache, noteChildRemoved, setChildReach } from './node-cache.js'
import { createLayoutNode } from './layout/engine.js'
import { LayoutMeasureMode, type LayoutNode } from './layout/node.js'
import type { FocusManager } from './focus.js'
import squashTextNodes from './squash-text-nodes.js'
import type { Color, Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrap-text.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type DOMNodeAttribute = Unbuilt

type TextName = Unbuilt
export type ElementNames =
  Unbuilt

export type DOMElement = Unbuilt

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
  return notBuilt('src/ink/dom.ts:169')
}

export function removeChildNode(parent: DOMElement, node: DOMNode): void {
  return notBuilt('src/ink/dom.ts:213')
}

export function setAttribute(
  node: DOMElement,
  key: string,
  value: DOMNodeAttribute,
): void {
  return notBuilt('src/ink/dom.ts:228')
}

function shallowStyleEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  return notBuilt('src/ink/dom.ts:239')
}

export function setStyle(node: DOMElement, style: Styles): void {
  return notBuilt('src/ink/dom.ts:254')
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
  return notBuilt('src/ink/dom.ts:307')
}

export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  return notBuilt('src/ink/dom.ts:315')
}
