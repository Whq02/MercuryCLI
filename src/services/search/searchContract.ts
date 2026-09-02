
export type SearchTier = 'native' | 'keyed' | 'keyless'

export type SearchBackendId =
  | 'anthropic-native'
  | 'openai-native'
  | 'brave'
  | 'tavily'
  | 'duckduckgo'
  | 'duckduckgo-lite'

export const SEARCH_BACKEND_LABELS: Record<SearchBackendId, string> = {
  'anthropic-native': 'Anthropic web search',
  'openai-native': 'OpenAI web search',
  brave: 'Brave Search',
  tavily: 'Tavily',
  duckduckgo: 'DuckDuckGo',
  'duckduckgo-lite': 'DuckDuckGo (lite)',
}

export function searchBackendLabel(id: SearchBackendId): string {
  return SEARCH_BACKEND_LABELS[id]
}

export interface SearchHit {
  title: string
  url: string
  snippet?: string
}

export interface SearchRequest {
  query: string
  allowedDomains?: string[]
  blockedDomains?: string[]
  maxResults?: number
  signal?: AbortSignal
}

export const DEFAULT_MAX_RESULTS = 10
export const MAX_SNIPPET_CHARS = 400

export type SearchFailureKind =
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

export interface SearchSuccess {
  ok: true
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]
  commentary?: string[]
  queries?: string[]
  sequence?: Array<string | { toolUseId: string; hits: SearchHit[] }>
}

export type SearchOutcome = SearchSuccess | SearchFailure

export interface SearchBackend {
  id: SearchBackendId
  tier: SearchTier
  search(request: SearchRequest): Promise<SearchOutcome>
}

export function searchFailure(
  kind: SearchFailureKind,
  via: SearchBackendId | 'none',
  message: string,
): SearchFailure {
  return { ok: false, kind, via, message }
}

export function searchUserAgent(): string {
  return `Mozilla/5.0 (compatible; Mercury/${MACRO.VERSION})`
}


export function hitHost(url: string): string | undefined {
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
  for (const hit of hits) {
    const url = hit.url.trim()
    const title = hit.title.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const snippet = hit.snippet?.trim()
    out.push({
      title: title === '' ? url : title,
      url,
      ...(snippet
        ? { snippet: snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS - 1)}…` : snippet }
        : {}),
    })
    if (out.length >= maxResults) break
  }
  return out
}


export const KEYED_DOOR_REMEDY = 'add a Brave or Tavily key with /router key brave (or /router key tavily) for richer results'

export function viaLine(via: SearchBackendId, tier: SearchTier): string {
  const label = searchBackendLabel(via)
  if (tier === 'keyless') return `via ${label} (keyless — ${KEYED_DOOR_REMEDY})`
  if (tier === 'keyed') return `via ${label} (keyed)`
  return `via ${label} (native)`
}

export function viaChip(via: SearchBackendId, tier: SearchTier): string {
  const label = searchBackendLabel(via)
  if (tier === 'keyless') return `via ${label} (keyless — add a Brave or Tavily key for richer results)`
  return `via ${label} (${tier})`
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
