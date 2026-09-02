// The element/text node model: a small DOM-like tree of typed nodes, tree
// mutation, dirty marking, the text measurement hook, and the scroll state
// record. The compose walk, the reconciler and the geometry modules all
// speak these exact field names.

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

/**
 * The single mutable home for scroll state; the scroll component, the
 * virtual-scroll consumer and the compose walk are its only writers.
 * Undefined clamp bounds mean "no clamp"; undefined lastStableAtBottom
 * means "never measured".
 */
export type ScrollState = {
  /** Current scroll offset in rows. */
  scrollTop?: number
  /** Accumulated not-yet-applied wheel delta. */
  pendingScrollDelta?: number
  /** Render-time clamp bounds written by the virtual-scroll consumer. */
  scrollClampMin?: number
  scrollClampMax?: number
  /** Measured content height / viewport height / absolute viewport top. */
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  /** Pin to the bottom as content grows. */
  stickyScroll?: boolean
  /** One-shot anchor resolved at render time from the element's fresh
   *  computed position. */
  scrollAnchor?: { el: DOMElement; offset: number }
  /** Previous compose's clamp gap (painted − intent), the progress guard
   *  for the clamp-hold drain: a gap that CHANGED means mounting advanced
   *  and another drain frame can advance the paint; an unchanged gap stops
   *  the chain until the next commit moves the bounds. */
  scrollClampGapPrev?: number
  /** The last-stable at-bottom truth from the last non-shrinking frame. */
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
  /** Survives style updates — it lives beside the style object, not in it. */
  isHidden?: boolean
  scroll?: ScrollState
  _eventHandlers?: Record<string, unknown>
  /** Captured only under the repaint-debug environment flag. */
  debugOwnerChain?: string[]
  // Root-only wiring (set by the instance):
  onRender?: () => void
  onImmediateRender?: () => void
  onComputeLayout?: () => void
  focusManager?: FocusManager
  /** Latched by the reconciler's test-environment commit guard. */
  hasRenderedContent?: boolean
}

export type TextNode = {
  nodeName: TextName
  parentNode: DOMElement | undefined
  nodeValue: string
  /** Text nodes never have a layout node; the field exists so a child
   *  lookup over the union types as `LayoutNode | undefined`. */
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
    // Worst-case tab expansion: actual expansion depends on the final screen
    // column.
    const text = expandTabs(raw)
    const natural = measureText(text, Number.POSITIVE_INFINITY)
    if (natural.width <= width) return natural
    // The engine probing sub-cell space: the answer is "no".
    if (natural.width >= 1 && width > 0 && width < 1) return natural
    if (text.includes('\n')) {
      if (widthMode === LayoutMeasureMode.Undefined) {
        // A pre-wrapped string must not be re-wrapped at a probe width,
        // which would inflate its height.
        return measureText(text, Math.max(width, natural.width))
      }
      // A carried constraint must be respected, or the rendered line count
      // exceeds the height layout reserved — and it must be the SAME wrap
      // the compositor paints (greedy word wrap per source line), never
      // ceil(cells / width): six 41-cell tokens in 80 columns paint eight
      // rows where the ceiling reserved six, and the next row overpainted
      // the tail (RHP-1).
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

/** The layout child index for a DOM child index: count only preceding
 *  children that own layout nodes (the two index spaces differ because of
 *  the three layout-less element kinds). */
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

/** Collect the committed rects of a removed subtree into the parent's
 *  pending-clear list, dropping the cache entries; an absolutely positioned
 *  node anywhere in the subtree flags the whole next frame off the
 *  previous-screen blit. */
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
    // No cached rect to clear, but the blit denial must still land.
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
  // React delivers a fresh children reference every render; storing it would
  // dirty everything every frame.
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

// Both React and the text component allocate a fresh object every render;
// unchanged text styles must not dirty the node.
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

/** Walk to the root setting the dirty flag on every element node; the FIRST
 *  measuring leaf on the path has its layout node invalidated for
 *  re-measurement — at most one such invalidation per walk. */
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

/** Reach the root's render callback for DOM-level mutations (scroll position
 *  changes) that must produce a frame without a React commit; callers pair
 *  this with dirty marking. */
export function scheduleRenderFrom(node?: DOMNode): void {
  let current: DOMNode | undefined = node
  while (current?.parentNode) current = current.parentNode
  if (current && isElement(current)) current.onRender?.()
}

/** Clear every layout reference in the subtree BEFORE the layout nodes are
 *  freed recursively, so no dangling reference into freed memory survives. */
export function clearLayoutNodeReferences(node: DOMNode): void {
  if (!isElement(node)) return
  node.layoutNode = undefined
  for (const child of node.childNodes) {
    clearLayoutNodeReferences(child)
  }
}

/**
 * The debug owner chain of the DEEPEST node whose vertical extent contains
 * the screen row. Prunes `display: none` AND nodes with no layout node at
 * all — the three layout-less element kinds terminate the walk. Chains are
 * only captured under the repaint-debug flag, so an empty result is normal.
 */
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
