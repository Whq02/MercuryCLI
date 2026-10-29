export type SearchTier = 'native' | 'keyed' | 'keyless'

export type SearchBackendId =
  | 'anthropic-native'
  | 'openai-native'
  | 'brave'
  | 'tavily'
  | 'duckduckgo'
  | 'duckduckgo-lite'
  | 'stackexchange'
  | 'npm'
  | 'pypi'
  | 'crates'
  | 'github'
  | 'hackernews'
  | 'wikipedia'
  | 'searxng'

const SEARCH_BACKEND_LABELS: Record<SearchBackendId, string> = {
  'anthropic-native': 'Anthropic web search',
  'openai-native': 'OpenAI web search',
  brave: 'Brave Search',
  tavily: 'Tavily',
  duckduckgo: 'DuckDuckGo',
  'duckduckgo-lite': 'DuckDuckGo (lite)',
  stackexchange: 'Stack Exchange',
  npm: 'npm',
  pypi: 'PyPI',
  crates: 'crates.io',
  github: 'GitHub code search',
  hackernews: 'Hacker News (Algolia)',
  wikipedia: 'Wikipedia',
  searxng: 'SearXNG',
}

export function searchBackendLabel(id: SearchBackendId): string {
  return SEARCH_BACKEND_LABELS[id]
}

export const SEARCH_SOURCE_TYPES = ['provider', 'brave', 'tavily', 'stackexchange', 'npm', 'pypi', 'crates', 'github', 'hackernews', 'wikipedia', 'searxng', 'duckduckgo'] as const
type SearchSourceType = (typeof SEARCH_SOURCE_TYPES)[number]

export interface SearchHit {
  title: string
  url: string
  snippet: string
  source_type: SearchSourceType
}

export interface SearchRequest {
  query: string

  allowedDomains?: string[]

  blockedDomains?: string[]

  maxResults?: number
  signal?: AbortSignal
  cacheScope?: string
}

export const DEFAULT_MAX_RESULTS = 10

export const MAX_SNIPPET_CHARS = 400

type SearchFailureKind =
  | 'no-backend'
  | 'rate-limited'
  | 'parse-failed'
  | 'network'
  | 'key-refused'
  | 'provider-refused'
  | 'aborted'

export interface SearchFailure {
  ok: false
  kind: SearchFailureKind
  via: SearchBackendId | 'none'

  message: string
}

interface SearchSuccess {
  ok: true
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]

  commentary?: string[]

  queries?: string[]

  sequence?: Array<string | { toolUseId: string; hits: SearchHit[] }>

  notes?: string[]
}

export type SearchOutcome = SearchSuccess | SearchFailure

export function searchFailure(
  kind: SearchFailureKind,
  via: SearchBackendId | 'none',
  message: string,
): SearchFailure {
  return { ok: false, kind, via, message }
}

export { webUserAgent as searchUserAgent } from '../../utils/webUserAgent.js'

function hitHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function domainMatches(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
  if (d === '') return false
  return host === d || host.endsWith(`.${d}`)
}

export function filterHitsByDomain(
  hits: readonly SearchHit[],
  allowedDomains?: readonly string[],
  blockedDomains?: readonly string[],
): SearchHit[] {
  const allowed = (allowedDomains ?? []).filter(d => d.trim() !== '')
  const blocked = (blockedDomains ?? []).filter(d => d.trim() !== '')
  if (allowed.length === 0 && blocked.length === 0) return [...hits]
  return hits.filter(hit => {
    const host = hitHost(hit.url)
    if (allowed.length > 0) {
      if (host === undefined) return false
      if (!allowed.some(d => domainMatches(host, d))) return false
    }
    if (blocked.length > 0 && host !== undefined && blocked.some(d => domainMatches(host, d))) return false
    return true
  })
}

export function normaliseHits(hits: readonly SearchHit[], maxResults = DEFAULT_MAX_RESULTS): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  const count = Math.min(DEFAULT_MAX_RESULTS, Math.max(0, Math.floor(maxResults)))
  if (!count) return out
  for (const hit of hits) {
    const url = hit.url.trim()
    const title = hit.title.trim()
    if (!/^https?:\/\//i.test(url) || !hitHost(url) || seen.has(url)) continue
    seen.add(url)
    const snippet = hit.snippet?.trim() ?? ''
    out.push({
      title: (title || url).slice(0, 160),
      url,
      snippet: snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS - 1)}…` : snippet,
      source_type: hit.source_type,
    })
    if (out.length >= count) break
  }
  return out
}

export const KEYED_DOOR_COMMANDS = 'BRAVE_API_KEY · TAVILY_API_KEY'

export const KEYED_DOOR_FREE_TIER = 'both offer a free tier'

export const KEYED_DOOR_REMEDY = `a Brave or Tavily key lifts the keyless door's rate limit — ${KEYED_DOOR_COMMANDS} (${KEYED_DOOR_FREE_TIER})`

export function viaLine(via: SearchBackendId, tier: SearchTier): string {
  return `via ${searchBackendLabel(via)} (${tier})`
}

export function viaChip(via: SearchBackendId, tier: SearchTier): string {
  return viaLine(via, tier)
}

export function failureLine(failure: SearchFailure): string {
  const who = failure.via === 'none' ? 'Web search' : searchBackendLabel(failure.via)
  switch (failure.kind) {
    case 'no-backend':
      return `Web search has no open door for this session: ${failure.message}`
    case 'rate-limited':
      return `${who} rate-limited this client: ${failure.message}`
    case 'parse-failed':
      return `${who} answered a shape Mercury does not recognise (no result was guessed): ${failure.message}`
    case 'network':
      return `${who} could not be reached: ${failure.message}`
    case 'key-refused':
      return `${who} refused the stored key: ${failure.message}`
    case 'provider-refused':
      return `${who} refused the search: ${failure.message}`
    case 'aborted':
      return `Web search cancelled.`
  }
}
