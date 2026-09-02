
import { useSyncExternalStore } from 'react'

let selected = -1
const listeners = new Set<() => void>()

export function getSelectedSuggestion(): number {
  return selected
}

export function setSelectedSuggestionStore(n: number): void {
  if (n === selected) return
  selected = n
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSelectedSuggestion(): number {
  return useSyncExternalStore(subscribe, getSelectedSuggestion)
}
