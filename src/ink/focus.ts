// The focus manager: PURE STATE — it holds no tree reference; callers pass
// the root when a walk is needed. It is stored on the root element so any
// node can reach it by walking parent links.

import type { DOMElement, DOMNode } from './dom.js'
import { FocusEvent } from './events/focus-event.js'

const FOCUS_STACK_LIMIT = 32

function isInTree(node: DOMElement): boolean {
  let current: DOMElement | undefined = node
  while (current.parentNode) current = current.parentNode
  return current.nodeName === 'ink-root'
}

function isElement(node: DOMNode): node is DOMElement {
  return node.nodeName !== '#text'
}

export class FocusManager {
  activeElement: DOMElement | null = null
  private enabled = true
  private readonly stack: DOMElement[] = []
  private readonly dispatchFocusEvent: (
    target: DOMElement,
    event: FocusEvent,
  ) => void

  constructor(dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => void) {
    this.dispatchFocusEvent = dispatchFocusEvent
  }

  focus(node: DOMElement): void {
    if (node === this.activeElement) return
    if (!this.enabled) return
    const previous = this.activeElement
    if (previous) {
      // Deduplicate before pushing, or tab cycling grows the stack without
      // bound.
      const existing = this.stack.indexOf(previous)
      if (existing !== -1) this.stack.splice(existing, 1)
      this.stack.push(previous)
      if (this.stack.length > FOCUS_STACK_LIMIT) this.stack.shift()
      this.dispatchFocusEvent(previous, new FocusEvent('blur', node))
    }
    this.activeElement = node
    this.dispatchFocusEvent(node, new FocusEvent('focus', previous))
  }

  blur(): void {
    const previous = this.activeElement
    if (!previous) return
    this.activeElement = null
    this.dispatchFocusEvent(previous, new FocusEvent('blur', null))
  }

  /** Handles both the exact removed node and any focused DESCENDANT of the
   *  removed subtree. */
  handleNodeRemoved(node: DOMElement, _root: DOMElement): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i]!
      if (entry === node || !isInTree(entry)) this.stack.splice(i, 1)
    }
    const active = this.activeElement
    if (!active) return
    if (active !== node && isInTree(active)) return
    this.activeElement = null
    this.dispatchFocusEvent(active, new FocusEvent('blur', null))
    // Restore focus to the most recent still-mounted stack entry.
    while (this.stack.length > 0) {
      const candidate = this.stack.pop()!
      if (isInTree(candidate)) {
        this.activeElement = candidate
        this.dispatchFocusEvent(candidate, new FocusEvent('focus', active))
        return
      }
    }
  }

  handleAutoFocus(node: DOMElement): void {
    this.focus(node)
  }

  /** Click-focusable = a numeric tab index of ANY value, negative included
   *  (programmatically focusable elements are click-focusable). */
  handleClickFocus(node: DOMElement): void {
    if (typeof node.attributes['tabIndex'] === 'number') this.focus(node)
  }

  enable(): void {
    this.enabled = true
  }

  /** Suppresses focus changes and tab movement, but not blur. */
  disable(): void {
    this.enabled = false
  }

  private collectTabbable(root: DOMElement): DOMElement[] {
    const tabbable: DOMElement[] = []
    const visit = (node: DOMNode): void => {
      if (!isElement(node)) return
      const tabIndex = node.attributes['tabIndex']
      // A negative tab index never appears in the cycle.
      if (typeof tabIndex === 'number' && tabIndex >= 0) tabbable.push(node)
      for (const child of node.childNodes) visit(child)
    }
    visit(root)
    return tabbable
  }

  private moveFocus(root: DOMElement, direction: 1 | -1): void {
    if (!this.enabled) return
    const tabbable = this.collectTabbable(root)
    if (tabbable.length === 0) return
    let index: number
    if (!this.activeElement) {
      index = direction === 1 ? 0 : tabbable.length - 1
    } else {
      const current = tabbable.indexOf(this.activeElement)
      index =
        (((current === -1 ? 0 : current + direction) % tabbable.length) +
          tabbable.length) %
        tabbable.length
    }
    this.focus(tabbable[index]!)
  }

  focusNext(root: DOMElement): void {
    this.moveFocus(root, 1)
  }

  focusPrevious(root: DOMElement): void {
    this.moveFocus(root, -1)
  }
}

/** The nearest ancestor (or the node itself) carrying a focus manager. */
export function getRootNode(node: DOMElement): DOMElement {
  let current: DOMElement | undefined = node
  while (current) {
    if (current.focusManager) return current
    current = current.parentNode
  }
  throw new Error('getRootNode: node is not in a tree with a focus manager')
}

export function getFocusManager(node: DOMElement): FocusManager {
  return getRootNode(node).focusManager!
}
