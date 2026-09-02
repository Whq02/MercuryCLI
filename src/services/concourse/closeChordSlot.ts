// ============================================================================
//  closeChordSlot — the one-slot claim on the Concourse close chord.
//
//  ctrl+x ctrl+x is bound in the GLOBAL block and its handler registers in
//  the REPL world (useGlobalKeybindings, routeSafe — the ctrl+x c precedent):
//  the parked REPL's ChordInterceptor owns the chord machinery even while
//  the Concourse covers it, so the completion is dispatched THERE and must
//  reach the board through a seam that carries zero Concourse modules.
//
//  The ConcourseScreen claims this slot at mount with its staged close
//  routine and React's own unmount cleanup releases it — a dead screen
//  cannot leave a live close verb behind. Unclaimed (any other surface, a
//  chat-world press), the dispatcher declines silently: the chord means
//  nothing where no board stands, exactly like a surface move onto an
//  absent stop.
// ============================================================================

export type CloseChordFn = () => void

let slot: CloseChordFn | null = null

/** Claim the close chord. Returns the release; call it from effect cleanup. */
export function claimConcourseCloseChord(fn: CloseChordFn): () => void {
  slot = fn
  return () => {
    if (slot === fn) slot = null
  }
}

/** Dispatch the completed chord into the claiming board, if one stands. */
export function invokeConcourseCloseChord(): void {
  slot?.()
}

/** Whether a board currently claims the chord (paint/prover truth). */
export function concourseCloseChordClaimed(): boolean {
  return slot !== null
}

/** Test seam — the module holds process state by design. */
export function resetConcourseCloseChordForTesting(): void {
  slot = null
}
