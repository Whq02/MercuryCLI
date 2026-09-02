
export type SurfaceSearchable = { name: string; description: string }

export function surfaceQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(t => t.length > 0)
}

export function emphasisSegments(
  text: string,
  tokens: readonly string[],
): Array<{ text: string; hit: boolean }> {
  const ranges: Array<[number, number]> = []
  for (const token of tokens) {
    if (token.length === 0) continue
    const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    for (const m of text.matchAll(re)) {
      let end = m.index + m[0].length
      while (end < text.length && /\p{M}/u.test(text[end]!)) end++
      ranges.push([m.index, end])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const out: Array<{ text: string; hit: boolean }> = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length || out.length === 0) out.push({ text: text.slice(cursor), hit: false })
  return out
}

export function matchesSurfaceQuery(
  s: SurfaceSearchable,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return true
  const hay = `/${s.name} ${s.description}`.toLowerCase()
  return tokens.every(t => hay.includes(t))
}

export function managerMetaLine(
  shown: number,
  total: number,
  filtering: boolean,
): string {
  return filtering
    ? `${shown} of ${total} match · ↵ opens for real`
    : `${total} surfaces · projected live from the command registry · ↵ opens for real`
}
