

export interface FuzzyResult {
  path: string
  score: number
}

export interface FuzzyIndex {
  search(query: string, limit: number): FuzzyResult[]
  size(): number
}

const TUNING = {
  perChar: 16,
  edgeBoundary: 8,
  edgeCamel: 6,
  leadChar: 8,
  runBonus: 4,
  gapOpen: 3,
  gapGrow: 1,
  shortStringCap: 32,
  digestSize: 100,
  queryCap: 64,
} as const


const SLASH = 47
const BACKSLASH = 92

function isSegmentEdge(code: number): boolean {
  return (
    code === SLASH ||
    code === BACKSLASH ||
    code === 45 ||
    code === 95 ||
    code === 46 ||
    code === 32
  )
}

function letterMask(s: string): number {
  let mask = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 97 && c <= 122) mask |= 1 << (c - 97)
  }
  return mask
}

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

  drain(): FuzzyResult[] {
    return this.entries
      .sort((a, b) => b.score - a.score)
      .map(({ path, score }) => ({ path, score }))
  }
}


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
  const folded: string[] = new Array(total)
  const masks = new Int32Array(total)
  for (let i = 0; i < total; i++) {
    const low = candidates[i].toLowerCase()
    folded[i] = low
    masks[i] = letterMask(low)
  }
  const digest = buildSegmentDigest(candidates)
  const matchAt = new Int32Array(TUNING.queryCap)

  return {
    size: () => total,

    search(query: string, limit: number): FuzzyResult[] {
      if (limit <= 0) return []
      if (!query) return digest.slice(0, limit)

      const foldedQuery = query.toLowerCase()
      const exactCase = query !== foldedQuery
      const needle = (exactCase ? query : foldedQuery).slice(0, TUNING.queryCap)
      const span = needle.length
      const needMask = letterMask(needle)

      const ceiling =
        span * (TUNING.perChar + TUNING.edgeBoundary) +
        TUNING.leadChar +
        TUNING.shortStringCap

      const shelf = new RankShelf(limit)

      candidate: for (let i = 0; i < total; i++) {
        if ((masks[i] & needMask) !== needMask) continue

        const text = exactCase ? candidates[i] : folded[i]

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

export function fuzzySearch(
  list: readonly string[],
  query: string,
  limit: number,
): FuzzyResult[] {
  return createFuzzyIndex(list).search(query, limit)
}
