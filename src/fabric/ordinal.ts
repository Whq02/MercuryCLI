// ============================================================================
//  fabric/ordinal — the JSON-safe scoped ordering codec.
//
//  Durable ordinals are canonical DECIMAL STRINGS ("7", "7.5", "7.75") —
//  JSON-safe, lexically stable, and insertable: a fork/import can order a
//  record between two existing ordinals without renumbering anything that
//  was already published. Runtime code may convert to number ONLY through
//  this codec. Comparisons are valid only within one declared scope
//  (session/thread lineage) — the fabric never compares ordinals across
//  unrelated lineages, and wall-clock never orders (occurredAt is
//  descriptive only).
//
// Allocator law (decided from current evidence): ONE restart-safe
//  sequencer per thread scope — the next creation ordinal is
//  floor(maxPublished) + 1, derived from the durable tail at open, so a
//  restart can never mint a duplicate or regressing ordinal. Between-record
//  insertion (imports, fork stitching) bisects the neighbors.
// ============================================================================

/** A canonical decimal-string ordinal. */
export type Ordinal = string & { readonly __brand: 'Ordinal' }

const ORDINAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/

export function isOrdinal(s: unknown): s is Ordinal {
  return typeof s === 'string' && ORDINAL_RE.test(s)
}

export function asOrdinal(s: string): Ordinal {
  if (!isOrdinal(s)) throw new Error(`not a canonical ordinal: ${JSON.stringify(s)}`)
  return s
}

export const ordinalOf = (n: number): Ordinal => {
  if (!Number.isFinite(n) || n < 0) throw new Error(`ordinal source out of range: ${n}`)
  const s = String(n)
  if (!ORDINAL_RE.test(s)) throw new Error(`ordinal source not canonical: ${s}`)
  return s as Ordinal
}

/** Numeric view (safe for the integer range the fabric mints; bisected
 *  ordinals stay exact through the decimal-string form). */
export const ordinalValue = (o: Ordinal): number => Number(o)

/** Total order within one scope. */
export function compareOrdinals(a: Ordinal, b: Ordinal): -1 | 0 | 1 {
  const na = Number(a)
  const nb = Number(b)
  return na < nb ? -1 : na > nb ? 1 : 0
}

/** The next whole creation ordinal after the published tail. */
export function nextOrdinal(maxPublished: Ordinal | null): Ordinal {
  if (maxPublished === null) return '1' as Ordinal
  return String(Math.floor(Number(maxPublished)) + 1) as Ordinal
}

/** An ordinal strictly between two neighbors (fork/import insertion). */
export function betweenOrdinals(a: Ordinal, b: Ordinal): Ordinal {
  const na = Number(a)
  const nb = Number(b)
  if (!(na < nb)) throw new Error(`no room between ordinals ${a} and ${b}`)
  const mid = (na + nb) / 2
  const s = String(mid)
  if (!ORDINAL_RE.test(s) || !(na < mid && mid < nb)) {
    throw new Error(`ordinal bisection exhausted between ${a} and ${b}`)
  }
  return s as Ordinal
}
