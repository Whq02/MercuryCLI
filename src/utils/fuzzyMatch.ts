/* ============================================================================
   fuzzyMatch — the palette engine: subsequence scoring over big string lists.

   One index serves every picker (command palette, agent studio, path lists).
   The ranking definition is CONTRACT DATA — callers and the palette prover
   pin it, and the tuning values below are load-bearing for result parity:
     · smart case — an all-lowercase query matches case-insensitively; any
       uppercase in the query flips the whole match case-sensitive;
     · greedy-earliest subsequence — each query char binds to its first
       occurrence after the previous one, or the candidate is out;
     · per-char score with consecutive-run bonuses, gap penalties, boundary
       and camelCase edge bonuses, and a shorter-string tiebreaker;
     · empty query — a digest of distinct leading path segments instead of a
       scan (pickers that dislike that view guard before calling);
     · bounded selection — only the `limit` best survive; admission once
       full is strictly-better-than-floor.
   Scale contract: hundreds of thousands of candidates per search. That is
   why candidates get a 26-bit letter mask (O(1) rejection), the walk reuses
   one scratch buffer, and a full candidate never allocates until it earns a
   shelf seat. Pure logic: no I/O, no clock, no randomness, no React.
   ============================================================================ */

export interface FuzzyResult {
  /** The stored candidate string, returned verbatim (callers key off it). */
  path: string
  /** Ranking score — larger is better; 0 on the empty-query digest. */
  score: number
}

export interface FuzzyIndex {
  search(query: string, limit: number): FuzzyResult[]
  size(): number
}

/** Ranking tuning — every value here changes result order; treat as frozen. */
const TUNING = {
  perChar: 16, // each matched query char
  edgeBoundary: 8, // match right after / \ - _ . or space
  edgeCamel: 6, // lowercase→Uppercase seam
  leadChar: 8, // match at position 0
  runBonus: 4, // zero-gap continuation
  gapOpen: 3, // first skipped char of a gap
  gapGrow: 1, // each further skipped char
  shortStringCap: 32, // tiebreak headroom: max(0, 32 − ⌊len/4⌋)
  digestSize: 100, // distinct segments the empty-query digest gathers
  queryCap: 64, // query chars considered
} as const

// ── character classes ───────────────────────────────────────────────────────

const SLASH = 47
const BACKSLASH = 92

function isSegmentEdge(code: number): boolean {
  // The boundary set: / \ - _ . space
  return (
    code === SLASH ||
    code === BACKSLASH ||
    code === 45 ||
    code === 95 ||
    code === 46 ||
    code === 32
  )
}

/** 26-bit mask of the a–z letters present (other characters set nothing). */
function letterMask(s: string): number {
  let mask = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 97 && c <= 122) mask |= 1 << (c - 97)
  }
  return mask
}

/** Edge bonus for a match at `at`, judged on the ORIGINAL-case string. */
function edgeBonus(original: string, at: number): number {
  if (at === 0) return TUNING.leadChar
  const before = original.charCodeAt(at - 1)
  if (isSegmentEdge(before)) return TUNING.edgeBoundary
  const here = original.charCodeAt(at)
  if (before >= 97 && before <= 122 && here >= 65 && here <= 90) {
    return TUNING.edgeCamel
  }
  return 0
}

// ── the empty-query digest ──────────────────────────────────────────────────

/** Distinct leading segments (text before the first slash of either kind),
 *  gathered in list order up to digestSize, ranked shortest-then-lexicographic. */
function buildSegmentDigest(candidates: string[]): FuzzyResult[] {
  const segments = new Set<string>()
  for (const candidate of candidates) {
    let cut = candidate.indexOf('/')
    const backCut = candidate.indexOf('\\')
    if (cut === -1 || (backCut !== -1 && backCut < cut)) {
      if (backCut !== -1) cut = backCut
    }
    const segment = cut === -1 ? candidate : candidate.slice(0, cut)
    if (segment.length === 0) continue
    segments.add(segment)
    if (segments.size >= TUNING.digestSize) break
  }
  const ranked = [...segments].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length
    return a < b ? -1 : a > b ? 1 : 0
  })
  return ranked.map((path) => ({ path, score: 0 }))
}

// ── bounded selection ───────────────────────────────────────────────────────

/** Keeps the `capacity` best entries. Held ascending once full; admission is
 *  strictly-above-floor, and a newly admitted score sits ahead of stored
 *  equals — the ranking's documented tie discipline. */
class RankShelf {
  private entries: { path: string; score: number }[] = []
  floor = -Infinity

  constructor(private readonly capacity: number) {}

  get full(): boolean {
    return this.entries.length === this.capacity
  }

  admit(path: string, score: number): void {
    if (!this.full) {
      this.entries.push({ path, score })
      if (this.full) {
        this.entries.sort((a, b) => a.score - b.score)
        this.floor = this.entries[0].score
      }
      return
    }
    if (score <= this.floor) return
    // leftmost seat whose occupant scores at least as much — equals go behind us
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.entries[mid].score < score) lo = mid + 1
      else hi = mid
    }
    this.entries.splice(lo, 0, { path, score })
    this.entries.shift()
    this.floor = this.entries[0].score
  }

  /** Best first; equal scores keep their shelf order (stable sort). */
  drain(): FuzzyResult[] {
    return this.entries
      .sort((a, b) => b.score - a.score)
      .map(({ path, score }) => ({ path, score }))
  }
}

// ── the index ───────────────────────────────────────────────────────────────

/** Build a searchable index over strings (paths, command names, …).
 *  Non-strings, empties, and duplicates are dropped up front. */
export function createFuzzyIndex(list: readonly string[]): FuzzyIndex {
  const candidates: string[] = []
  {
    const seen = new Set<string>()
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue
      seen.add(entry)
      candidates.push(entry)
    }
  }

  const total = candidates.length
  const folded: string[] = new Array(total) // lowercased once, up front
  const masks = new Int32Array(total) // 26-bit letter masks of the folded forms
  for (let i = 0; i < total; i++) {
    const low = candidates[i].toLowerCase()
    folded[i] = low
    masks[i] = letterMask(low)
  }
  const digest = buildSegmentDigest(candidates)
  const matchAt = new Int32Array(TUNING.queryCap) // scratch: positions of one walk

  return {
    size: () => total,

    search(query: string, limit: number): FuzzyResult[] {
      if (limit <= 0) return []
      if (!query) return digest.slice(0, limit)

      // Smart case, then cap the needle.
      const foldedQuery = query.toLowerCase()
      const exactCase = query !== foldedQuery
      const needle = (exactCase ? query : foldedQuery).slice(0, TUNING.queryCap)
      const span = needle.length
      const needMask = letterMask(needle)

      // A true upper bound on any candidate's final score, given its walk's
      // run/gap terms — lets a full shelf skip the edge-bonus pass outright.
      const ceiling =
        span * (TUNING.perChar + TUNING.edgeBoundary) +
        TUNING.leadChar +
        TUNING.shortStringCap

      const shelf = new RankShelf(limit)

      candidate: for (let i = 0; i < total; i++) {
        // O(1) reject: the candidate must hold every a–z letter of the needle.
        if ((masks[i] & needMask) !== needMask) continue

        const text = exactCase ? candidates[i] : folded[i]

        // Greedy-earliest walk, aggregating run bonuses and gap penalties.
        let runs = 0
        let gaps = 0
        let cursor = text.indexOf(needle[0])
        if (cursor === -1) continue
        matchAt[0] = cursor
        for (let j = 1; j < span; j++) {
          const next = text.indexOf(needle[j], cursor + 1)
          if (next === -1) continue candidate
          matchAt[j] = next
          const skipped = next - cursor - 1
          if (skipped === 0) runs += TUNING.runBonus
          else gaps += TUNING.gapOpen + skipped * TUNING.gapGrow
          cursor = next
        }

        if (shelf.full && ceiling + runs - gaps <= shelf.floor) continue

        const original = candidates[i]
        let score = span * TUNING.perChar + runs - gaps
        for (let j = 0; j < span; j++) score += edgeBonus(original, matchAt[j])
        const headroom = TUNING.shortStringCap - (original.length >> 2)
        if (headroom > 0) score += headroom

        shelf.admit(original, score)
      }

      return shelf.drain()
    },
  }
}

/** One-shot convenience over createFuzzyIndex for palette-sized lists. */
export function fuzzySearch(
  list: readonly string[],
  query: string,
  limit: number,
): FuzzyResult[] {
  return createFuzzyIndex(list).search(query, limit)
}
