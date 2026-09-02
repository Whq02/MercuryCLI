
import { currentInputEventSeq } from '../ink/events/input-event.js'

export interface OverlayEntry {
  readonly token: number
  readonly id: string
  readonly modal: boolean
  readonly openSeq: number
  readonly onFocusReturn?: () => void
  readonly ownsPageKeys?: boolean
}

let stack: OverlayEntry[] = []
let version = 0
let nextToken = 1
let lastPopEventSeq = -1
const listeners = new Set<() => void>()

function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

export function reserveOverlayToken(): number {
  return nextToken++
}

export function pushOverlay(entry: {
  id: string
  modal: boolean
  token?: number
  onFocusReturn?: () => void
  ownsPageKeys?: boolean
}): number {
  const token = entry.token ?? nextToken++
  const withoutDup = stack.filter(e => e.token !== token)
  stack = [
    ...withoutDup,
    {
      token,
      id: entry.id,
      modal: entry.modal,
      openSeq: currentInputEventSeq(),
      onFocusReturn: entry.onFocusReturn,
      ownsPageKeys: entry.ownsPageKeys,
    },
  ]
  bump()
  return token
}

export function popOverlay(token: number): void {
  const idx = stack.findIndex(e => e.token === token)
  if (idx === -1) return
  const wasTop = idx === stack.length - 1
  const entry = stack[idx]!
  stack = [...stack.slice(0, idx), ...stack.slice(idx + 1)]
  lastPopEventSeq = currentInputEventSeq()
  bump()
  if (wasTop && entry.onFocusReturn) {
    try {
      entry.onFocusReturn()
    } catch {
    }
  }
}

export function overlayStackVersion(): number {
  return version
}

export function subscribeOverlayStack(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function overlayStackSnapshot(): readonly OverlayEntry[] {
  return stack
}

export function anyOverlayActive(): boolean {
  return stack.length > 0
}

export function anyModalOverlayActive(): boolean {
  return stack.some(e => e.modal)
}

export function topOverlay(): OverlayEntry | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null
}

export function topOverlayOwnsPageKeys(): boolean {
  return topOverlay()?.ownsPageKeys === true
}

export function isTopOverlayNow(token: number): boolean {
  if (lastPopEventSeq === currentInputEventSeq() && lastPopEventSeq !== -1) {
    return false
  }
  const top = topOverlay()
  return top !== null && top.token === token
}

export function resetOverlayStackForTests(): void {
  stack = []
  lastPopEventSeq = -1
  bump()
}
