import type { DOMElement, DOMNode } from './dom.js'
import { FocusEvent } from './events/focus-event.js'
import { notBuilt, unbuilt } from '../pi/holes.js'

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
  activeElement: DOMElement | null = unbuilt('src/ink/focus.ts:24')
  private enabled: boolean = unbuilt('src/ink/focus.ts:25')
  private readonly stack: DOMElement[] = unbuilt('src/ink/focus.ts:26')
  private readonly dispatchFocusEvent: (
    target: DOMElement,
    event: FocusEvent,
  ) => void

  constructor(dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => void) {
    notBuilt('src/ink/focus.ts:32')
  }

  focus(node: DOMElement): void {
    return notBuilt('src/ink/focus.ts:36')
  }

  blur(): void {
    return notBuilt('src/ink/focus.ts:47')
  }

  handleNodeRemoved(node: DOMElement, _root: DOMElement): void {
    return notBuilt('src/ink/focus.ts:54')
  }

  handleAutoFocus(node: DOMElement): void {
    return notBuilt('src/ink/focus.ts:74')
  }

  handleClickFocus(node: DOMElement): void {
    return notBuilt('src/ink/focus.ts:78')
  }

  enable(): void {
    return notBuilt('src/ink/focus.ts:82')
  }

  disable(): void {
    return notBuilt('src/ink/focus.ts:86')
  }

  private collectTabbable(root: DOMElement): DOMElement[] {
    return notBuilt('src/ink/focus.ts:90')
  }

  private moveFocus(root: DOMElement, direction: 1 | -1): void {
    return notBuilt('src/ink/focus.ts:102')
  }

  focusNext(root: DOMElement): void {
    return notBuilt('src/ink/focus.ts:119')
  }

  focusPrevious(root: DOMElement): void {
    return notBuilt('src/ink/focus.ts:123')
  }
}
