/**
 * The legacy-id re-key — the pure half of the one-shot migration (ledger
 * L27): map every EXACT occurrence of a legacy operator id to the keyed id
 * inside an arbitrary JSON value. Whole-string matches only — a legacy id is
 * a 15-character high-entropy token (`op-` + 12 hex), so an exact match IS a
 * reference to the operator; substring rewriting could touch prose and is
 * deliberately out of scope. Object KEYS and values are both covered.
 *
 * Size-preserving by construction: the keyed generation shares the legacy
 * shape and length, so a re-keyed serialization is byte-for-byte the same
 * length as the original (the room re-key's safety invariant rides this).
 */

export interface RekeyResult<T> {
  value: T
  /** Exact-match substitutions performed (0 ⇒ `value` IS the input). */
  changed: number
}

export function rekeyLegacyOperatorIds<T>(
  value: T,
  legacyIds: readonly string[],
  newId: string,
): RekeyResult<T> {
  if (legacyIds.length === 0) return { value, changed: 0 }
  let changed = 0
  const map = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (legacyIds.includes(v)) {
        changed++
        return newId
      }
      return v
    }
    if (Array.isArray(v)) {
      let out: unknown[] | null = null
      for (let i = 0; i < v.length; i++) {
        const m = map(v[i])
        if (m !== v[i]) {
          if (!out) out = [...v]
          out[i] = m
        }
      }
      return out ?? v
    }
    if (typeof v === 'object' && v !== null) {
      let out: Record<string, unknown> | null = null
      for (const [k, inner] of Object.entries(v)) {
        const mk = legacyIds.includes(k) ? (changed++, newId) : k
        const mv = map(inner)
        if (mk !== k || mv !== inner) {
          if (!out) out = { ...(v as Record<string, unknown>) }
          if (mk !== k) delete out[k]
          out[mk] = mv
        }
      }
      return out ?? v
    }
    return v
  }
  const mapped = map(value) as T
  return { value: mapped, changed }
}
