
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

export const ordinalValue = (o: Ordinal): number => Number(o)

export function compareOrdinals(a: Ordinal, b: Ordinal): -1 | 0 | 1 {
  const na = Number(a)
  const nb = Number(b)
  return na < nb ? -1 : na > nb ? 1 : 0
}

export function nextOrdinal(maxPublished: Ordinal | null): Ordinal {
  if (maxPublished === null) return '1' as Ordinal
  return String(Math.floor(Number(maxPublished)) + 1) as Ordinal
}

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
