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

function rememberFocused(history: DOMElement[], element: DOMElement): void {
  const earlier = history.indexOf(element)
  if (earlier !== -1) history.splice(earlier, 1)
  if (history.push(element) > FOCUS_STACK_LIMIT) history.shift()
}

export class FocusManager {
  activeElement: DOMElement | null = null
  private enabled: boolean = true
  private readonly stack: DOMElement[] = []
  private readonly dispatchFocusEvent: (
    target: DOMElement,
    event: FocusEvent,
  ) => void

  constructor(dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => void) {
    this.dispatchFocusEvent = dispatchFocusEvent
  }

  focus(node: DOMElement): void {
    if (!this.enabled || node === this.activeElement) return
    const previous = this.activeElement
    if (previous) {
      rememberFocused(this.stack, previous)
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

  handleNodeRemoved(node: DOMElement, _root: DOMElement): void {
    for (let at = this.stack.length - 1; at >= 0; at--) {
      const entry = this.stack[at]!
      if (entry === node || !isInTree(entry)) this.stack.splice(at, 1)
    }
    const lost = this.activeElement
    if (!lost || (lost !== node && isInTree(lost))) return
    this.activeElement = null
    this.dispatchFocusEvent(lost, new FocusEvent('blur', null))
    while (this.stack.length > 0) {
      const restored = this.stack.pop()!
      if (!isInTree(restored)) continue
      this.activeElement = restored
      this.dispatchFocusEvent(restored, new FocusEvent('focus', lost))
      return
    }
  }

  handleAutoFocus(node: DOMElement): void {
    this.focus(node)
  }

  handleClickFocus(node: DOMElement): void {
    if (typeof node.attributes['tabIndex'] === 'number') this.focus(node)
  }

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }

  private collectTabbable(root: DOMElement): DOMElement[] {
    const found: DOMElement[] = []
    const walk = (node: DOMElement): void => {
      const tabIndex = node.attributes['tabIndex']
      if (typeof tabIndex === 'number' && tabIndex >= 0) found.push(node)
      for (const child of node.childNodes) {
        if (isElement(child)) walk(child)
      }
    }
    walk(root)
    return found
  }

  private moveFocus(root: DOMElement, direction: 1 | -1): void {
    if (!this.enabled) return
    const candidates = this.collectTabbable(root)
    if (candidates.length === 0) return
    const active = this.activeElement
    const at = active ? candidates.indexOf(active) : -1
    let next = 0
    if (at !== -1) next = (at + direction + candidates.length) % candidates.length
    else if (!active && direction === -1) next = candidates.length - 1
    this.focus(candidates[next]!)
  }

  focusNext(root: DOMElement): void {
    this.moveFocus(root, 1)
  }

  focusPrevious(root: DOMElement): void {
    this.moveFocus(root, -1)
  }
}
