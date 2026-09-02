// ============================================================================
//  src/native-ts/file-index/index.ts — the fuzzy file index, replacing a
//  vendored native matcher. Internal scores are higher-is-better; the
//  RETURNED score is positional (best = 0.0, lower is better).
// ============================================================================

export type SearchResult = { path: string; score: number }

/** Chunk duration: time-based, not count-based, so slow machines take
 *  smaller chunks and stay responsive (contract data, exported). */
export const CHUNK_MS = 4

/** Macrotask yield (a microtask would not unblock the event loop). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

const MAX_QUERY_LENGTH = 64
const TOP_LEVEL_CAP = 100
const BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' '])

// fzf-v2/nucleo bonus weights (contract data — they define the ranking).
const SCORE_MATCH = 16
const BONUS_ADJACENT = 4
const GAP_OPEN = 3
const GAP_EXTEND = 1
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_FIRST_CHAR_START = 8

function letterBitmap(lower: string): number {
  let bits = 0
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i)
    if (code >= 97 && code <= 122) bits |= 1 << (code - 97)
  }
  return bits
}

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private bitmaps: number[] = []
  private lengths: number[] = []
  private readyCount = 0
  private topLevelCache: SearchResult[] | null = null

  private reset(): void {
    this.paths = []
    this.lowerPaths = []
    this.bitmaps = []
    this.lengths = []
    this.readyCount = 0
    this.topLevelCache = null
  }

  private dedupe(list: string[]): string[] {
    const seen = new Set<string>()
    const unique: string[] = []
    for (const path of list) {
      if (path === '' || seen.has(path)) continue
      seen.add(path)
      unique.push(path)
    }
    return unique
  }

  /** Top-level segments, computed at build time: first path segment,
   *  unique and non-empty, capped at 100 distinct, sorted by length then
   *  lexicographically, each scored 0. */
  private computeTopLevel(unique: string[]): void {
    const segments = new Set<string>()
    for (const path of unique) {
      if (segments.size >= TOP_LEVEL_CAP) break
      const slash = path.search(/[/\\]/)
      const segment = slash === -1 ? path : path.slice(0, slash)
      if (segment !== '') segments.add(segment)
    }
    this.topLevelCache = [...segments]
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, TOP_LEVEL_CAP)
      .map(path => ({ path, score: 0 }))
  }

  private precomputeOne(index: number): void {
    const path = this.paths[index]!
    const lower = path.toLowerCase()
    // Separator-fold the MATCH string only (never this.paths, which stays
    // native for display + insertion): a query typed with '/' must match an
    // index whose entries are '\'-separated (Windows `rg` output), and an
    // index that is '/'-separated (a git-sourced listing, '/' even on win32)
    // must match a '\'-typed query. Folding both sides to one separator here
    // and in search() canonicalises matching on every host; it is a no-op on
    // POSIX '/'-only paths. Backslash-to-slash is 1:1 and length-preserving,
    // so match offsets still index this.paths for the boundary bonuses.
    this.lowerPaths[index] = lower.replace(/\\/g, '/')
    this.bitmaps[index] = letterBitmap(lower)
    this.lengths[index] = path.length
  }

  loadFromFileList(list: string[]): void {
    this.reset()
    const unique = this.dedupe(list)
    this.paths = unique
    this.computeTopLevel(unique)
    for (let i = 0; i < unique.length; i++) this.precomputeOne(i)
    this.readyCount = unique.length
  }

  /**
   * Async load: `queryable` resolves at the first yield of the precompute
   * pass (searches then see the ready prefix); `done` when the whole index
   * is built. A small list resolves both together. BOTH passes chunk on
   * elapsed time (amortised to every 256 iterations).
   */
  loadFromFileListAsync(list: string[]): { queryable: Promise<void>; done: Promise<void> } {
    this.reset()
    let resolveQueryable!: () => void
    const queryable = new Promise<void>(resolve => {
      resolveQueryable = resolve
    })
    const done = (async () => {
      // Pass 1 — de-duplication, chunked.
      const seen = new Set<string>()
      const unique: string[] = []
      let chunkStart = Date.now()
      for (let i = 0; i < list.length; i++) {
        if ((i & 255) === 0 && Date.now() - chunkStart > CHUNK_MS) {
          await yieldToEventLoop()
          chunkStart = Date.now()
        }
        const path = list[i]!
        if (path === '' || seen.has(path)) continue
        seen.add(path)
        unique.push(path)
      }
      this.paths = unique
      // The empty-query cache is correct BEFORE the precompute pass begins.
      this.computeTopLevel(unique)
      // Pass 2 — precompute, chunked; ready prefix advances per chunk.
      let queryableResolved = false
      chunkStart = Date.now()
      for (let i = 0; i < unique.length; i++) {
        if ((i & 255) === 0 && Date.now() - chunkStart > CHUNK_MS) {
          this.readyCount = i
          if (!queryableResolved) {
            queryableResolved = true
            resolveQueryable()
          }
          await yieldToEventLoop()
          chunkStart = Date.now()
        }
        this.precomputeOne(i)
      }
      this.readyCount = unique.length
      if (!queryableResolved) resolveQueryable()
    })()
    return { queryable, done }
  }

  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0) return []
    if (query === '') {
      if (this.topLevelCache === null) return []
      return this.topLevelCache.slice(0, limit)
    }
    const truncated = query.slice(0, MAX_QUERY_LENGTH)
    // Smart case: any uppercase makes the whole query case-sensitive.
    const caseSensitive = /[A-Z]/.test(truncated)
    // Canonicalise separators in the needle to the folded haystacks
    // (precomputeOne folds lowerPaths; the case-sensitive branch folds the
    // native path on the fly). Separators are not letters, so queryBits is
    // unaffected.
    const needle = (caseSensitive ? truncated : truncated.toLowerCase()).replace(/\\/g, '/')
    const queryBits = letterBitmap(truncated.toLowerCase())

    type Scored = { index: number; score: number }
    const best: Scored[] = []
    let worstKept = -Infinity

    for (let i = 0; i < this.readyCount; i++) {
      if ((this.bitmaps[i]! & queryBits) !== queryBits) continue
      // The case-sensitive branch folds the native path here (length-preserving,
      // so match offsets still index `original`); the case-folded branch reads
      // the pre-folded lowerPaths. `original` stays native for the boundary bonuses.
      const haystack = caseSensitive ? this.paths[i]!.replace(/\\/g, '/') : this.lowerPaths[i]!
      const original = this.paths[i]!
      // Greedy-earliest subsequence match with fzf-style bonuses.
      let score = 0
      let previousMatch = -1
      let position = 0
      let matched = true
      for (let q = 0; q < needle.length; q++) {
        const found = haystack.indexOf(needle[q]!, position)
        if (found === -1) {
          matched = false
          break
        }
        score += SCORE_MATCH
        if (previousMatch !== -1) {
          if (found === previousMatch + 1) {
            score += BONUS_ADJACENT
          } else {
            score -= GAP_OPEN + GAP_EXTEND * (found - previousMatch - 1)
          }
        }
        // Boundary/camel bonuses read the ORIGINAL-case path.
        if (found === 0) {
          if (q === 0) score += BONUS_FIRST_CHAR_START
          score += BONUS_BOUNDARY
        } else {
          const prevChar = original[found - 1]!
          if (BOUNDARY_CHARS.has(prevChar)) {
            score += BONUS_BOUNDARY
          } else if (
            prevChar >= 'a' &&
            prevChar <= 'z' &&
            original[found]! >= 'A' &&
            original[found]! <= 'Z'
          ) {
            score += BONUS_CAMEL
          }
        }
        previousMatch = found
        position = found + 1
      }
      if (!matched) continue
      score += Math.max(0, 32 - Math.floor(this.lengths[i]! / 4))

      if (best.length >= limit && score <= worstKept) continue
      best.push({ index: i, score })
      best.sort((a, b) => b.score - a.score)
      if (best.length > limit) best.pop()
      worstKept = best[best.length - 1]!.score
    }

    // Returned scores are POSITIONAL (best = 0.0, lower is better); the
    // test-path penalty perturbs only the value, never the order, and is
    // arithmetically inert at index 0.
    const n = best.length
    return best.map((entry, i) => {
      const path = this.paths[entry.index]!
      let score = i / Math.max(n, 1)
      if (path.includes('test')) score = Math.min(1, score * 1.05)
      return { path, score }
    })
  }
}

export type FileIndexType = FileIndex

export default FileIndex
