
export interface RekeyResult<T> {
  value: T
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
