
import type { ParsedKeystroke } from './types.js'

type Listener = () => void

let pending: ParsedKeystroke[] | null = null
const listeners = new Set<Listener>()

export function publishPendingChord(next: ParsedKeystroke[] | null): void {
  if (pending === next) return
  pending = next
  for (const fn of [...listeners]) fn()
}

export function getPendingChordMirror(): ParsedKeystroke[] | null {
  return pending
}

export function subscribePendingChordMirror(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function resetPendingChordMirrorForTesting(): void {
  pending = null
  listeners.clear()
}
