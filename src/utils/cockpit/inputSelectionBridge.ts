// ============================================================================
//  utils/cockpit/inputSelectionBridge — the tiny module-level bridge between
//  the PROMPT INPUT's screen→text-range selection adapter (PromptInput
//  registers it) and the selection-CLEARING key handler
//  (ScrollKeybindingHandler observes "any key clears the highlight").
//
//  Why it exists: both are useInput subscribers, and useInput fires EVERY
//  handler in registration order — whichever mounts first wins. The clear
//  handler would otherwise null the selection before the text input's handler could
//  read it, so a drag-highlight over the input + ⌫ deleted ONE char (the
//  operator report). With the bridge, the clear path first asks
//  "would the input consume this selection?" and, for delete-shaped keys,
//  leaves consumption (and the clear) to the input seam — deterministic in
//  EITHER registration order:
//    · clear handler first → sees a consumable range → skips clearing →
//      the input seam consumes the range and clears the selection;
//    · input seam first → consumed + cleared → the clear handler's
//      hasSelection() guard early-returns.
//
//  Registration is PromptInput-mount-scoped (unregister on unmount / fn
//  change); a null consumer means "no input on screen" and the clear path
//  behaves exactly as before.
// ============================================================================

type RangeFn = () => { start: number; end: number } | null

let consumer: RangeFn | null = null

/** Register the live input's selection adapter. Returns the unregister. */
export function registerInputSelectionConsumer(fn: RangeFn): () => void {
  consumer = fn
  return () => {
    if (consumer === fn) consumer = null
  }
}

/** Non-null when the CURRENT screen selection maps to a consumable text
 *  range inside the live prompt input (both endpoints inside its rect). */
export function peekInputSelectionRange(): { start: number; end: number } | null {
  try {
    return consumer?.() ?? null
  } catch {
    // The adapter reads layout caches — never let a geometry edge case
    // break key handling; a throw just means "not consumable".
    return null
  }
}
