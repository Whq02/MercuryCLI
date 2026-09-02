// ============================================================================
//  suggestionSelectionStore — the typeahead SELECTION cursor as a module
//  store.
//
//  Why: the selection index lived in PromptInput React state, so every ↑↓ on
//  the suggestion list re-rendered the ENTIRE composer (2.8k-line component +
//  footer + hints) — measured 22–43ms keypress→selection-paint on the 1k
//  fixture against the ≤20ms law, with composer ECHO at ~4ms on the same
//  screen (probe-nav-latency.ts receipts). The index is consumed by exactly
//  one leaf (PromptInputFooterSuggestions) and by event-time handlers — so it
//  rides a subscribed store: moves re-render ONLY the suggestion leaf.
//
//  Contract: PromptInput's setSuggestionsState seam is the ONLY writer
//  (selection legality — clamping, preserve-by-id across refreshes — stays in
//  useTypeahead's updaters); handlers read getSelectedSuggestion() at event
//  time (never a render closure); the leaf subscribes via the hook.
// ============================================================================

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
      /* a throwing subscriber never blocks the others */
    }
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The suggestion leaf's subscription — selection moves re-render ONLY its
 *  subscribers, never the composer. */
export function useSelectedSuggestion(): number {
  return useSyncExternalStore(subscribe, getSelectedSuggestion)
}
