// ============================================================================
//  render-engine/cockpit/recordFold.ts — the dialect-seam fold (E10's edge
//  on the REAL settlement path).
//
//  The turn loop mints ONE assistant message per settled content block on
//  every dialect (compat/openai/zai lanes), each with a fresh uuid. The fold
//  keys each settlement by DURABLE coordinates:
//
//      run ordinal · ROUND index · role · block position in the round
//
//  and NEVER by per-request ids. The turn machine's callId stamp is
//  `t{round}.c{attempt}` — the t-part is the round, the c-part is a request
//  attempt (provider-fallback retries mint c2 for the SAME round), so the
//  fold key takes the t-part alone and counts block positions per attempt:
//  a re-presentation of an already-recorded settlement (same round, same
//  position, fresh uuid — the wire-replay class spec 10 B1 names, and the
//  retry re-mint shape) REFOLDS onto the recorded row. The newest reference
//  lands under the FIRST uuid; the transcript can never gain a second copy
//  of the same settled block.
//
//  Measured ground (prove-doubles-growth-curve): on the current
//  product path re-presentations do not occur — 40 turns × 3 dialects ×
//  1/2/5-parallel rounds settle flat at 1 copy per row, so every ingest is
//  'recorded' today. The fold is the STRUCTURAL law the design demands
//  (a settled row cannot gain a copy, by construction), and a refold is
//  therefore also a tripwire: fixture builds arm onRefold to turn one into
//  a loud stop; production folds silently and counts.
// ============================================================================

export interface FoldOutcome {
  /** The uuid the settlement must be written under: its own on 'recorded',
   *  the FIRST mint's uuid on 'refolded' (the append seam's replace-in-place
   *  law then lands the newest content on the existing row). */
  readonly uuid: string
  readonly outcome: 'recorded' | 'refolded'
  readonly foldKey: string
}

export interface RecordFoldOptions {
  /** Armed in fixture/dev drives: a refold is an upstream double-emit —
   *  report it loudly (the census's mechanical form). */
  onRefold?: (foldKey: string, firstUuid: string, freshUuid: string) => void
}

/** callId `t{round}.c{attempt}` → its round term; a foreign spelling is its
 *  own term (never merged with a real round). */
function roundOf(callId: string): string {
  const dot = callId.indexOf('.')
  return dot > 0 ? callId.slice(0, dot) : callId
}

export class RecordFold {
  private runSeq = 0
  private readonly byFoldKey = new Map<string, string>()
  private readonly attemptPositions = new Map<string, number>()
  private refoldCount = 0

  constructor(private readonly options: RecordFoldOptions = {}) {}

  /** A new query run begins (one runQuery claim): rounds restart at t1
   *  inside the machine, so the run ordinal is the outer durable term. */
  beginRun(): void {
    this.runSeq++
    this.attemptPositions.clear()
  }

  /**
   * Fold one assistant settlement. `callId` is the turn machine's own
   * `t{round}.c{attempt}` stamp riding the assistant_settled event. Block
   * positions count per ATTEMPT (an abandoned attempt's retry re-mints from
   * position 0), while the fold key carries only the ROUND — so a retry's
   * block 0 refolds onto the first attempt's block 0.
   */
  ingestSettlement(callId: string, mintedUuid: string): FoldOutcome {
    const position = this.attemptPositions.get(callId) ?? 0
    this.attemptPositions.set(callId, position + 1)
    const foldKey = `r${this.runSeq}:${roundOf(callId)}:b${position}:assistant`
    const existing = this.byFoldKey.get(foldKey)
    if (existing !== undefined && existing !== mintedUuid) {
      this.refoldCount++
      this.options.onRefold?.(foldKey, existing, mintedUuid)
      return { uuid: existing, outcome: 'refolded', foldKey }
    }
    this.byFoldKey.set(foldKey, mintedUuid)
    return { uuid: mintedUuid, outcome: 'recorded', foldKey }
  }

  /** An explicit retraction (the mid-stream fallback tombstone) frees the
   *  settlement's coordinates: the retry's re-mint is then a NEW recording
   *  on a clean row, not a refold onto a removed one. */
  retractByUuid(uuid: string): void {
    for (const [key, held] of this.byFoldKey) {
      if (held === uuid) this.byFoldKey.delete(key)
    }
  }

  /** Presentations folded onto existing rows (diagnostics / the tripwire). */
  refolds(): number {
    return this.refoldCount
  }
}
