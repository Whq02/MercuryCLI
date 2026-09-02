
export type SearchResult = { path: string; score: number }

export const CHUNK_MS = 4

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

const MAX_QUERY_LENGTH = 64
const TOP_LEVEL_CAP = 100
const BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' '])

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

  loadFromFileListAsync(list: string[]): { queryable: Promise<void>; done: Promise<void> } {
    this.reset()
    let resolveQueryable!: () => void
    const queryable = new Promise<void>(resolve => {
      resolveQueryable = resolve
    })
    const done = (async () => {
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
      this.computeTopLevel(unique)
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
    const caseSensitive = /[A-Z]/.test(truncated)
    const needle = (caseSensitive ? truncated : truncated.toLowerCase()).replace(/\\/g, '/')
    const queryBits = letterBitmap(truncated.toLowerCase())

    type Scored = { index: number; score: number }
    const best: Scored[] = []
    let worstKept = -Infinity

    for (let i = 0; i < this.readyCount; i++) {
      if ((this.bitmaps[i]! & queryBits) !== queryBits) continue
      const haystack = caseSensitive ? this.paths[i]!.replace(/\\/g, '/') : this.lowerPaths[i]!
      const original = this.paths[i]!
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
