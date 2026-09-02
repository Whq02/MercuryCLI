// ============================================================================
//  managerFilter — the /manager search grammar (pure, bun-loadable).
//
//  Token-AND over name + description: the query splits on whitespace into
//  lowercase tokens; a surface survives when EVERY token substring-matches
//  its `/name` + description haystack (case-insensitive). No tokens (empty
//  or whitespace-only query) means NO filter — the view keeps its ORIGINAL
//  rows array, so the resting grouped view is byte-identical by construction
//  (the capture-stability contract). Table-proved in
//  scripts/interaction/prove-manager-filter.ts.
// ============================================================================

export type SurfaceSearchable = { name: string; description: string }

/** Lowercase whitespace-split query tokens; [] for empty/whitespace input. */
export function surfaceQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(t => t.length > 0)
}

/** The match emphasis: `text` split into segments, the query tokens' hits
 *  marked so a row can weight them (bold, never a colour — colour stays
 *  reserved for the selected row). Case-insensitive on the ORIGINAL text
 *  (no lowercased copy, so indices never drift on special casings), a hit
 *  extends over trailing combining marks so an accented glyph is never cut
 *  in half, and hits never overlap. No tokens ⇒ one unmarked segment. */
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

/** Token-AND: every token substring-matches the `/name` + description
 *  haystack. The leading slash keeps `/sta`-style queries matching the row
 *  exactly as painted. */
export function matchesSurfaceQuery(
  s: SurfaceSearchable,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return true
  const hay = `/${s.name} ${s.description}`.toLowerCase()
  return tokens.every(t => hay.includes(t))
}

/** The meta line under the search row. Resting: the exact pre-search line
 *  (byte-stability — pinned captures ride on it). Filtering: the truthful
 *  `N of M match` count, kept short enough to hold one line at 80 columns
 *  (ManagerView's intro budget counts on a single row; the provenance
 *  segment returns with the resting view). */
export function managerMetaLine(
  shown: number,
  total: number,
  filtering: boolean,
): string {
  return filtering
    ? `${shown} of ${total} match · ↵ opens for real`
    : `${total} surfaces · projected live from the command registry · ↵ opens for real`
}
