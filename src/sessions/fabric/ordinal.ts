
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

export function nextOrdinal(maxPublished: Ordinal | null): Ordinal {
  if (maxPublished === null) return '1' as Ordinal
  return String(Math.floor(Number(maxPublished)) + 1) as Ordinal
}

