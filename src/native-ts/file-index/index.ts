import { sleep } from '../../utils/sleep.js'

type SearchResult = { path: string; score: number }

const CHUNK_MS = 4

function yieldToEventLoop(): Promise<void> {
  return sleep(0)
}

const MAX_QUERY_LENGTH = 64
const TOP_LEVEL_CAP = 100
const BOUNDARY_CHARS = new Set(['/', '\\', '-', '_', '.', ' '])

function normalizeSeparators(value: string): string {
  return value.includes('\\') ? value.replaceAll('\\', '/') : value
}

function asciiLetterBitmap(value: string): number {
  let mask = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 97 && code <= 122) {
      mask |= 1 << (code - 97)
    } else if (code >= 65 && code <= 90) {
      mask |= 1 << (code - 65)
    }
  }
  return mask
}

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private bitmaps: number[] = []
  private lengths: number[] = []
  private readyCount: number = 0
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
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]!
      if (entry.length === 0 || seen.has(entry)) continue
      seen.add(entry)
      unique.push(entry)
    }
    return unique
  }

  private computeTopLevel(unique: string[]): void {
    const seen = new Set<string>()
    const segments: string[] = []
    for (let i = 0; i < unique.length; i++) {
      const entry = unique[i]!
      const slash = entry.indexOf('/')
      const backslash = entry.indexOf('\\')
      let sep = -1
      if (slash !== -1 && backslash !== -1) {
        sep = slash < backslash ? slash : backslash
      } else if (slash !== -1) {
        sep = slash
      } else {
        sep = backslash
      }
      const segment = sep === -1 ? entry : entry.slice(0, sep)
      if (segment.length === 0 || seen.has(segment)) continue
      seen.add(segment)
      segments.push(segment)
      if (segments.length >= TOP_LEVEL_CAP) break
    }
    segments.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    this.topLevelCache = segments.map(path => ({ path, score: 0 }))
  }

  private precomputeOne(index: number): void {
    const original = this.paths[index]!
    const lower = normalizeSeparators(original.toLowerCase())
    this.lowerPaths[index] = lower
    this.bitmaps[index] = asciiLetterBitmap(lower)
    this.lengths[index] = original.length
  }

  loadFromFileList(list: string[]): void {
    this.reset()
    const unique = this.dedupe(list)
    this.paths = unique
    this.lowerPaths = new Array<string>(unique.length)
    this.bitmaps = new Array<number>(unique.length)
    this.lengths = new Array<number>(unique.length)
    this.computeTopLevel(unique)
    for (let i = 0; i < unique.length; i++) {
      this.precomputeOne(i)
    }
    this.readyCount = unique.length
  }

  loadFromFileListAsync(list: string[]): { queryable: Promise<void>; done: Promise<void> } {
    this.reset()
    let resolveQueryable!: () => void
    let queryableResolved = false
    const queryable = new Promise<void>(resolve => {
      resolveQueryable = resolve
    })
    const markQueryable = (): void => {
      if (!queryableResolved) {
        queryableResolved = true
        resolveQueryable()
      }
    }

    const done = (async () => {
      const seen = new Set<string>()
      const unique: string[] = []
      let chunkStart = performance.now()
      for (let i = 0; i < list.length; i++) {
        const entry = list[i]!
        if (entry.length > 0 && !seen.has(entry)) {
          seen.add(entry)
          unique.push(entry)
        }
        if ((i & 255) === 255 && performance.now() - chunkStart > CHUNK_MS) {
          await yieldToEventLoop()
          chunkStart = performance.now()
        }
      }

      this.paths = unique
      this.lowerPaths = new Array<string>(unique.length)
      this.bitmaps = new Array<number>(unique.length)
      this.lengths = new Array<number>(unique.length)
      this.computeTopLevel(unique)

      chunkStart = performance.now()
      for (let i = 0; i < unique.length; i++) {
        this.precomputeOne(i)
        if ((i & 255) === 255 && performance.now() - chunkStart > CHUNK_MS) {
          this.readyCount = i + 1
          markQueryable()
          await yieldToEventLoop()
          chunkStart = performance.now()
        }
      }
      this.readyCount = unique.length
      markQueryable()
    })()

    return { queryable, done }
  }

  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0) return []
    if (query.length === 0) {
      if (this.topLevelCache === null) return []
      return this.topLevelCache.slice(0, limit)
    }

    const prefix = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query
    let caseSensitive = false
    let queryMask = 0
    for (let i = 0; i < prefix.length; i++) {
      const code = prefix.charCodeAt(i)
      if (code >= 65 && code <= 90) {
        caseSensitive = true
        queryMask |= 1 << (code - 65)
      } else if (code >= 97 && code <= 122) {
        queryMask |= 1 << (code - 97)
      }
    }

    const normalizedQuery = normalizeSeparators(prefix)
    const needle = caseSensitive ? normalizedQuery : normalizedQuery.toLowerCase()
    const needleLength = needle.length
    const ready = this.readyCount
    const candidates: SearchResult[] = []

    for (let i = 0; i < ready; i++) {
      if ((this.bitmaps[i]! & queryMask) !== queryMask) continue
      const original = this.paths[i]!
      const haystack = caseSensitive ? normalizeSeparators(original) : this.lowerPaths[i]!

      let score = 0
      let prevPos = -1
      let searchFrom = 0
      let matched = true

      for (let qi = 0; qi < needleLength; qi++) {
        const pos = haystack.indexOf(needle[qi]!, searchFrom)
        if (pos === -1) {
          matched = false
          break
        }

        score += 16

        if (prevPos !== -1) {
          if (pos === prevPos + 1) {
            score += 4
          } else {
            score -= 3 + (pos - prevPos - 1)
          }
        }

        if (pos === 0) {
          score += 8
          if (qi === 0) {
            score += 8
          }
        } else {
          const prevChar = original[pos - 1]
          if (prevChar !== undefined && BOUNDARY_CHARS.has(prevChar)) {
            score += 8
          } else {
            const prevCode = original.charCodeAt(pos - 1)
            const currCode = original.charCodeAt(pos)
            if (prevCode >= 97 && prevCode <= 122 && currCode >= 65 && currCode <= 90) {
              score += 6
            }
          }
        }

        prevPos = pos
        searchFrom = pos + 1
      }

      if (!matched) continue

      score += Math.max(0, 32 - Math.floor(this.lengths[i]! / 4))

      if (candidates.length === limit && score <= candidates[limit - 1]!.score) {
        continue
      }

      let lo = 0
      let hi = candidates.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (candidates[mid]!.score >= score) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      candidates.splice(lo, 0, { path: original, score })
      if (candidates.length > limit) {
        candidates.pop()
      }
    }

    const count = candidates.length
    const results: SearchResult[] = new Array<SearchResult>(count)
    for (let rank = 0; rank < count; rank++) {
      const path = candidates[rank]!.path
      let normalized = rank / count
      if (path.includes('test')) {
        normalized = Math.min(1, normalized * 1.05)
      }
      results[rank] = { path, score: normalized }
    }
    return results
  }
}

export default FileIndex
