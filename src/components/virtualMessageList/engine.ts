import type { SearchQuery } from '../../utils/transcriptSearch.js'

export const JUMP_HEADROOM_ROWS = 3
export const PHANTOM_LIMIT = 20
export const MOUNT_ATTEMPT_LIMIT = 3
export const WARM_CHUNK = 500

export type JumpHandle = {
  jumpToIndex: (index: number) => void
  setSearchQuery: (query: string) => void
  nextMatch: () => void
  prevMatch: () => void
  setAnchor: () => void
  warmSearchIndex: () => Promise<number>
  disarmSearch: () => void
}

export type SearchEngineState = {
  query: SearchQuery | null
  counts: number[]
  prefix: number[]
  total: number
  messagePointer: number
  ordinal: number
  wrapStart: number
  phantomRun: number
  mountAttempts: number
  seekInFlight: boolean
  queuedStep: 1 | -1 | null
  anchor: number | null
  pendingTimer: ReturnType<typeof setTimeout> | null
  warm: boolean
}

export function newEngineState(): SearchEngineState {
  return {
    query: null,
    counts: [],
    prefix: [],
    total: 0,
    messagePointer: -1,
    ordinal: 0,
    wrapStart: -1,
    phantomRun: 0,
    mountAttempts: 0,
    seekInFlight: false,
    queuedStep: null,
    anchor: null,
    pendingTimer: null,
    warm: false,
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}
