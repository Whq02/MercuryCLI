// ============================================================================
//  services/search/searchContract — the ONE web-search contract every door
//  answers through (the provider-neutral search owner).
//
//  A search is a question any model can ask — a frontier model on any
//  provider family, or a local model on the box — so the tool never depends
//  on one vendor's wire. Every backend answers this contract: a normalised
//  hit list, the backend that answered (`via`) and its tier, and typed
//  failures AS VALUES the tool renders as one honest line — never a silent
//  empty, never raw provider prose posing as a result.
//
//  Tiers:
//    'native'  — the main model's OWN provider carries a search construct on
//                its wire (Anthropic's server tool · OpenAI's Responses
//                web_search); used only for a session whose main model IS
//                that family — never as a fallback for another family (the
//                cross-account law: a credential of family X is never spent
//                from a session whose main model is family Y).
//    'keyed'   — a search-API key the operator stored in Mercury's own
//                secret store (Brave Search · Tavily).
//    'keyless' — DuckDuckGo's no-JS endpoints; works the moment Mercury is
//                installed, no account anywhere.
//
//  This module is a dependency-free leaf: the search door, the tool, the
//  provider lanes' neutral request type and the provers all read it.
// ============================================================================

export type SearchTier = 'native' | 'keyed' | 'keyless'

export type SearchBackendId =
  | 'anthropic-native'
  | 'openai-native'
  | 'brave'
  | 'tavily'
  | 'duckduckgo'
  | 'duckduckgo-lite'

/** The ONE backend display-name table — every surface that names a search
 *  backend derives its label here. */
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
  /** The backend's own excerpt when it carries one (keyed and keyless
   *  doors do; the native doors hand back model commentary instead). */
  snippet?: string
}

export interface SearchRequest {
  query: string
  /** Only hits on these domains (host equal to, or a subdomain of, an
   *  entry). Every backend post-filters; natives pass the list on the
   *  wire too. */
  allowedDomains?: string[]
  /** Never a hit on these domains. */
  blockedDomains?: string[]
  /** Hit ceiling for the list backends (default DEFAULT_MAX_RESULTS). */
  maxResults?: number
  signal?: AbortSignal
}

export const DEFAULT_MAX_RESULTS = 10
/** Snippets are bounded so a verbose backend cannot flood the model. */
export const MAX_SNIPPET_CHARS = 400

/**
 * The typed failure classes — each is a different FACT with a different
 * remedy, so the tool's one line can say which happened:
 *   'no-backend'       no door is open for this session (every door refused
 *                      or was switched off);
 *   'rate-limited'     the backend throttled or challenged this client;
 *   'parse-failed'     the backend answered a shape Mercury does not
 *                      recognise (a changed page or JSON shape — never a
 *                      guessed result);
 *   'network'          the backend could not be reached (DNS, TLS, deadline);
 *   'key-refused'      a keyed backend rejected the stored key;
 *   'provider-refused' a native door's provider answered with an error;
 *   'aborted'          the operator's own cancel (propagates, never relabelled).
 */
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
  /** Operator-worded; NEVER carries a key value (the secrets law). */
  message: string
}

export interface SearchSuccess {
  ok: true
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]
  /** Model commentary — only a native door produces it. */
  commentary?: string[]
  /** The queries the backend actually ran (a native model may refine). */
  queries?: string[]
  /** A native door's stream-ordered settlement: commentary strings
   *  interleaved with per-search hit groups, exactly as the model produced
   *  them (the tool keeps this order in its persisted results). */
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

/**
 * The ONE user-agent every non-native search backend sees (ruled):
 * version only — no URL, no repo name, no operator identity;
 * a public homepage may be appended when one exists. Stable across
 * requests; Mozilla-compatible in form; names the product honestly.
 */
export function searchUserAgent(): string {
  return `Mozilla/5.0 (compatible; Mercury/${MACRO.VERSION})`
}

// ── the domain law (pure) ───────────────────────────────────────────────────

/** A hit's host, lower-cased, a leading `www.` detached; undefined for an
 *  unparseable url (such a hit never passes an allow list and always
 *  passes a block list — the filter cannot vouch for it either way). */
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

/**
 * The one domain filter every door's hits pass through: an allow list keeps
 * only hits whose host is one of the listed domains or a subdomain of one;
 * a block list drops those. Backends that carry the lists natively still
 * pass here (post-filtering is the floor; the wire's own filter is a
 * courtesy that saves results, never the law).
 */
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

/** Normalise a backend's hits: drop blanks and duplicates (by url), bound
 *  the snippet, cap the count. */
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

// ── the honest lines ────────────────────────────────────────────────────────

/** The remedy every keyless-door sentence ends with — the one place the
 *  key door is named to the operator. */
export const KEYED_DOOR_REMEDY = 'add a Brave or Tavily key with /router key brave (or /router key tavily) for richer results'

/** The `via` line the model-facing result carries — which door answered,
 *  and for the keyless door, how to open a better one. */
export function viaLine(via: SearchBackendId, tier: SearchTier): string {
  const label = searchBackendLabel(via)
  if (tier === 'keyless') return `via ${label} (keyless — ${KEYED_DOOR_REMEDY})`
  if (tier === 'keyed') return `via ${label} (keyed)`
  return `via ${label} (native)`
}

/** The transcript row's one-line spelling of the same fact. */
export function viaChip(via: SearchBackendId, tier: SearchTier): string {
  const label = searchBackendLabel(via)
  if (tier === 'keyless') return `via ${label} (keyless — add a Brave or Tavily key for richer results)`
  return `via ${label} (${tier})`
}

/** The ONE line a failed search renders — the kind's fact, the backend's
 *  own words, the remedy. */
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
