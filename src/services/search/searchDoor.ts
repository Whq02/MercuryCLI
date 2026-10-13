import type { ToolUseContext } from '../../Tool.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { AbortError } from '../../utils/errors.js'
import { getEngineModel } from '../../utils/model/model.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { braveSearch, resolveBraveSearchApiKey, type SearchKeySource } from './brave.js'
import { keylessSearch } from './duckduckgo.js'
import { nativeBackendIdFor, nativeSearch, type SearchProgressSink } from './nativeSearch.js'
import { isNativeSearchFamily, type NativeSearchFamily } from './nativeSearchRequest.js'
import { officialSearch } from './officialSearch.js'
import { searxngSearch } from './searxng.js'
import { officialSearchIntent, type OfficialSearchSource } from './searchSources.js'
import { cachedAnswerNote, coolDownRemainingMs, liveSearchClock, nextSearchGroupId, noteAnswered, noteRateLimited, rememberSearch, secondsLeftLabel, takeCachedSearch, takeKeyedDoorHint, type SearchClock } from './searchPacing.js'
import { failureLine, KEYED_DOOR_COMMANDS, KEYED_DOOR_FREE_TIER, normaliseHits, searchBackendLabel, searchFailure, type SearchBackendId, type SearchFailure, type SearchHit, type SearchOutcome, type SearchRequest, type SearchTier } from './searchContract.js'
import { resolveTavilyApiKey, tavilySearch } from './tavily.js'

export type SearchDoor =
  | { kind: 'native'; family: NativeSearchFamily }
  | { kind: 'keyed'; backend: 'brave' | 'tavily'; keySource: SearchKeySource }
  | { kind: 'official'; backend: OfficialSearchSource; words: string }
  | { kind: 'metasearch' }
  | { kind: 'keyless' }
export const SEARCH_BACKEND_OVERRIDES = ['auto', 'brave', 'tavily', 'duckduckgo'] as const
export type SearchBackendOverride = (typeof SEARCH_BACKEND_OVERRIDES)[number]
export interface SearchDoorReads {
  braveKey?: SearchKeySource
  tavilyKey?: SearchKeySource
  backendOverride?: string
  keylessAllowed: boolean
  mainModel?: string
}
export interface SearchDoorPlan { doors: SearchDoor[]; closed: string[]; override: SearchBackendOverride }

export function parseSearchBackendOverride(raw: string | undefined): SearchBackendOverride | { invalid: string } {
  const word = (raw ?? '').trim().toLowerCase()
  if (word === '') return 'auto'
  return (SEARCH_BACKEND_OVERRIDES as readonly string[]).includes(word) ? word as SearchBackendOverride : { invalid: raw ?? '' }
}
export function nativeSearchFamilyOf(mainModel: string): NativeSearchFamily | undefined {
  const route = declaredRouteOf(mainModel)
  return route !== null && isNativeSearchFamily(route) ? route : undefined
}
export function resolveSearchDoorPlan(reads: SearchDoorReads, query = ''): SearchDoorPlan {
  const parsed = parseSearchBackendOverride(reads.backendOverride)
  if (typeof parsed !== 'string') return { doors: [], closed: [`MERCURY_SEARCH_BACKEND='${parsed.invalid}' names no door (takes ${SEARCH_BACKEND_OVERRIDES.join(' · ')})`], override: 'auto' }
  const keyed: SearchDoor[] = []
  if (reads.braveKey) keyed.push({ kind: 'keyed', backend: 'brave', keySource: reads.braveKey })
  if (reads.tavilyKey) keyed.push({ kind: 'keyed', backend: 'tavily', keySource: reads.tavilyKey })
  if (parsed === 'brave' || parsed === 'tavily') {
    const door = keyed.find(d => d.kind === 'keyed' && d.backend === parsed)
    return door ? { doors: [door], closed: [], override: parsed } : { doors: [], closed: [`MERCURY_SEARCH_BACKEND=${parsed}, but no ${searchBackendLabel(parsed)} key is present (${parsed === 'brave' ? 'BRAVE_API_KEY or /router key brave' : 'TAVILY_API_KEY or /router key tavily'})`], override: parsed }
  }
  if (parsed === 'duckduckgo') return reads.keylessAllowed
    ? { doors: [{ kind: 'keyless' }], closed: [], override: parsed }
    : { doors: [], closed: ['MERCURY_SEARCH_BACKEND=duckduckgo, but the scraping door is off (MERCURY_SEARCH_KEYLESS=0)'], override: parsed }
  const doors: SearchDoor[] = []
  const family = reads.mainModel ? nativeSearchFamilyOf(reads.mainModel) : undefined
  if (family) doors.push({ kind: 'native', family })
  doors.push(...keyed)
  const intent = officialSearchIntent(query)
  if (intent) doors.push({ kind: 'official', backend: intent.source, words: intent.words })
  doors.push({ kind: 'metasearch' })
  if (reads.keylessAllowed) doors.push({ kind: 'keyless' })
  const closed = []
  if (!keyed.length) closed.push(`no Brave or Tavily key stored (${KEYED_DOOR_COMMANDS} — ${KEYED_DOOR_FREE_TIER})`)
  if (!reads.keylessAllowed) closed.push('DuckDuckGo scraping is off (MERCURY_SEARCH_KEYLESS=0)')
  return { doors, closed, override: parsed }
}
export function liveSearchDoorReads(env: Record<string, string | undefined> = process.env): SearchDoorReads {
  const brave = resolveBraveSearchApiKey(env), tavily = resolveTavilyApiKey(env)
  return {
    ...(brave ? { braveKey: brave.source } : {}), ...(tavily ? { tavilyKey: tavily.source } : {}),
    ...(flagEnv('MERCURY_SEARCH_BACKEND') !== undefined ? { backendOverride: flagEnv('MERCURY_SEARCH_BACKEND') } : {}),
    keylessAllowed: flagEnabled('MERCURY_SEARCH_KEYLESS'),
  }
}
export function searchDoorLabel(door: SearchDoor): string {
  switch (door.kind) {
    case 'native': return `${searchBackendLabel(nativeBackendIdFor(door.family))} (native, session account)`
    case 'keyed': return `${searchBackendLabel(door.backend)} (keyed, ${door.keySource === 'env' ? 'env key' : 'stored key'})`
    case 'official': return `${searchBackendLabel(door.backend)} (official API)`
    case 'metasearch': return 'SearXNG (public JSON API)'
    case 'keyless': return 'DuckDuckGo (keyless)'
  }
}
export function describeSearchDoorPlan(plan: SearchDoorPlan): string {
  return `${plan.doors.length ? plan.doors.map(searchDoorLabel).join(' → ') : 'no source selected for this query'}${plan.override === 'auto' ? '' : ` [MERCURY_SEARCH_BACKEND=${plan.override}]`}${plan.closed.length ? ` · not in the walk: ${plan.closed.join('; ')}` : ''}`
}
export function searchDoorFact(mainModel: string, env: Record<string, string | undefined> = process.env): string {
  return `WebSearch: ${describeSearchDoorPlan(resolveSearchDoorPlan({ ...liveSearchDoorReads(env), mainModel }))} · official APIs selected by query shape`
}
export interface WebSearchRun {
  via: SearchBackendId; tier: SearchTier; hits: SearchHit[]
  sequence: Array<string | { toolUseId: string; hits: SearchHit[] }>
  queries: string[]; notes: string[]; hint?: string; cached?: boolean
}
export interface WebSearchRunIo {
  context: ToolUseContext
  onProgress?: SearchProgressSink
  reads?: SearchDoorReads
  backends?: {
    native?: (family: NativeSearchFamily, request: SearchRequest) => Promise<SearchOutcome>
    brave?: (request: SearchRequest) => Promise<SearchOutcome>
    tavily?: (request: SearchRequest) => Promise<SearchOutcome>
    official?: (source: OfficialSearchSource, words: string, request: SearchRequest) => Promise<SearchOutcome>
    metasearch?: (request: SearchRequest) => Promise<SearchOutcome>
    keyless?: (request: SearchRequest) => Promise<SearchOutcome>
  }
  clock?: SearchClock
}
async function openDoor(door: SearchDoor, request: SearchRequest, io: WebSearchRunIo, clock: SearchClock): Promise<SearchOutcome> {
  switch (door.kind) {
    case 'native': return io.backends?.native ? io.backends.native(door.family, request) : nativeSearch(door.family, request, io)
    case 'keyed': return door.backend === 'brave' ? (io.backends?.brave ?? braveSearch)(request) : (io.backends?.tavily ?? tavilySearch)(request)
    case 'official': return io.backends?.official ? io.backends.official(door.backend, door.words, request) : officialSearch(door.backend, door.words, request, { clock })
    case 'metasearch': return io.backends?.metasearch ? io.backends.metasearch(request) : searxngSearch(request, { clock })
    case 'keyless': return io.backends?.keyless ? io.backends.keyless(request) : keylessSearch(request, { clock })
  }
}
export interface WalkFailureContext { nativeFamily?: NativeSearchFamily }
export function walkFailureLine(failures: readonly SearchFailure[], plan: SearchDoorPlan, _walk: WalkFailureContext = {}): string {
  let line = 'No source answered; try another wording or another source.'
  for (const fact of [...failures.map(failureLine), ...plan.closed]) {
    const next = `${line} ${fact.replace(/\s+/g, ' ').trim()}`
    if (Buffer.byteLength(next, 'utf8') < 2000) line = next
  }
  return line
}
export async function performWebSearch(input: SearchRequest, io: WebSearchRunIo): Promise<WebSearchRun> {
  const clock = io.clock ?? liveSearchClock
  const mainModel = (io.context.options.engineModel as string | undefined) || getEngineModel()
  const plan = resolveSearchDoorPlan({ ...(io.reads ?? liveSearchDoorReads()), mainModel }, input.query)
  const signal = input.signal ? AbortSignal.any([input.signal, io.context.abortController.signal]) : io.context.abortController.signal
  const request = { ...input, signal, cacheScope: `${mainModel}:${JSON.stringify(plan)}` }
  if (signal.aborted) throw new AbortError()
  const report = (id: string, count: number): void => io.onProgress?.({ toolUseID: id, data: { type: 'search_results_received', resultCount: count, query: request.query } })
  const cached = takeCachedSearch(request, clock.now())
  if (cached) {
    const id = nextSearchGroupId(cached.via)
    report(id, cached.hits.length)
    return { via: cached.via, tier: cached.tier, hits: cached.hits, sequence: [{ toolUseId: id, hits: cached.hits }], queries: cached.queries, notes: [...(cached.notes ?? []), cachedAnswerNote(searchBackendLabel(cached.via))], cached: true }
  }
  const failures: SearchFailure[] = []
  for (const door of plan.doors) {
    if (signal.aborted) throw new AbortError()
    if (door.kind === 'keyed') {
      const left = coolDownRemainingMs(door.backend, clock.now())
      if (left > 0) { failures.push(searchFailure('rate-limited', door.backend, `wait ${secondsLeftLabel(left)}; no request made`)); continue }
    }
    let outcome: SearchOutcome
    try { outcome = await openDoor(door, request, io, clock) } catch {
      if (signal.aborted) throw new AbortError()
      failures.push(searchFailure('network', door.kind === 'native' ? nativeBackendIdFor(door.family) : door.kind === 'keyless' ? 'duckduckgo' : door.kind === 'metasearch' ? 'searxng' : door.backend, 'this source did not complete the search'))
      continue
    }
    if (signal.aborted || (!outcome.ok && outcome.kind === 'aborted')) throw new AbortError()
    if (outcome.ok) {
      const hits = normaliseHits(outcome.hits, request.maxResults)
      if (door.kind === 'keyed') noteAnswered(door.backend)
      if (!hits.length) { failures.push(searchFailure('no-backend', outcome.via, `${searchBackendLabel(outcome.via)} found no matching links`)); continue }
      const queries = outcome.queries ?? [request.query]
      if (outcome.via !== 'github') rememberSearch(request, { via: outcome.via, tier: outcome.tier, hits, queries, notes: outcome.notes }, clock.now())
      const id = nextSearchGroupId(outcome.via)
      report(id, hits.length)
      const hint = outcome.tier === 'keyless' && !plan.doors.some(d => d.kind === 'keyed') ? takeKeyedDoorHint() : undefined
      return { via: outcome.via, tier: outcome.tier, hits, sequence: [{ toolUseId: id, hits }], queries, notes: [...(outcome.notes ?? []), ...failures.map(failureLine)], ...(hint ? { hint } : {}) }
    }
    if (door.kind === 'keyed' && outcome.kind === 'rate-limited') noteRateLimited(door.backend, clock)
    failures.push(outcome)
  }
  throw new Error(walkFailureLine(failures, plan))
}
