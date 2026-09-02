// ============================================================================
//  render-engine/stablePrefix.ts — the stable-prefix discipline for streamed
//  bodies (spec 02, absorbed as engine law).
//
//  A streaming body's cost per flush is O(delta), not O(body): the cache
//  keeps the longest PROVABLY-SAFE prefix already rendered — its rendered
//  rows and the width that produced them — and each flush renders only the
//  tail past the boundary. Prefix rows, once promoted, are never re-derived,
//  and the boundary search scans only the delta since the last flush using
//  cached cumulative counts.
//
//  A safe boundary is conservative by construction: any doubt means no
//  boundary (the tail renders whole). The engine ships the blank-line
//  boundary with a cumulative fence guard; a host renderer with richer
//  markdown knowledge plugs its own scanner through BoundaryScanner. The
//  cache DROPS on a width change and whenever the new content is not an
//  extension of the cached prefix (retry/rewrite) — correctness never rides
//  on the cache.
// ============================================================================

/** Incremental boundary scanner: fed only the delta, answers with the
 *  furthest safe cut seen so far (an offset into the FULL body), and resets
 *  with the cache. */
export interface BoundaryScanner {
  /** Scan body[scannedTo, body.length); return the furthest safe cut known,
   *  monotonic across calls. */
  advance(body: string): number
  reset(): void
}

/** The conservative default: a boundary sits immediately after a blank line,
 *  and only while the cumulative fence count to its left is even (an open
 *  ``` fence disqualifies every cut inside it). Scans each byte once. */
export class BlankLineBoundary implements BoundaryScanner {
  private scanned = 0 // always a line-start offset
  private fences = 0
  private safeCut = 0

  advance(body: string): number {
    let i = this.scanned
    while (i < body.length) {
      const nl = body.indexOf('\n', i)
      if (nl === -1) break // partial line — wait for its end
      const line = body.slice(i, nl)
      if (/^\s*```/.test(line)) this.fences++
      if (line.length === 0 && this.fences % 2 === 0) this.safeCut = nl + 1
      i = nl + 1
    }
    this.scanned = i
    return this.safeCut
  }

  reset(): void {
    this.scanned = 0
    this.fences = 0
    this.safeCut = 0
  }
}

export interface StreamRender {
  /** All rows for the body at this width: cached prefix rows ++ fresh tail
   *  rows. */
  rows: readonly string[]
  /** How many leading rows came from the cache untouched. */
  stableRows: number
}

export class StreamBodyCache {
  private prefixText = ''
  private prefixRows: string[] = []
  /** The full body as last seen — the boundary scanner's stream truth. A
   *  new body must EXTEND it; a rewrite anywhere past the promoted prefix
   *  still poisons the incremental scan state, so any non-extension drops
   *  the whole cache (conservative, correct). */
  private lastBody = ''
  private width = -1
  private promotions = 0
  private renderedChars = 0

  constructor(
    private readonly render: (text: string, width: number) => string[],
    private readonly boundary: BoundaryScanner = new BlankLineBoundary(),
  ) {}

  /** Prefix promotions performed (each renders only its delta). */
  prefixPromotions(): number {
    return this.promotions
  }

  /** Characters handed to the renderer across all flushes — the O(delta)
   *  receipt a prover compares against body length × flushes. */
  charsRendered(): number {
    return this.renderedChars
  }

  /** Render the full body at `width`, reusing the stable prefix. */
  update(body: string, width: number): StreamRender {
    if (width !== this.width || !body.startsWith(this.lastBody)) {
      // Width change or a non-extension (retry/rewrite) of the SCANNED
      // stream: the cache and the scanner drop together.
      this.prefixText = ''
      this.prefixRows = []
      this.width = width
      this.boundary.reset()
    }
    this.lastBody = body
    const cut = this.boundary.advance(body)
    if (cut > this.prefixText.length) {
      const delta = body.slice(this.prefixText.length, cut)
      const deltaRows = this.render(delta, width)
      this.renderedChars += delta.length
      this.promotions++
      this.prefixRows = this.prefixRows.concat(deltaRows)
      this.prefixText = body.slice(0, cut)
    }
    const tail = body.slice(this.prefixText.length)
    let tailRows: string[] = []
    if (tail.length > 0) {
      tailRows = this.render(tail, width)
      this.renderedChars += tail.length
    }
    return {
      rows: this.prefixRows.concat(tailRows),
      stableRows: this.prefixRows.length,
    }
  }

  /** Drop everything (turn settled or abandoned). */
  reset(): void {
    this.prefixText = ''
    this.prefixRows = []
    this.lastBody = ''
    this.width = -1
    this.boundary.reset()
  }
}
