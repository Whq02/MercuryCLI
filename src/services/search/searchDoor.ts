// ============================================================================
//  services/search/searchDoor — the VENDORED search's one selection law, and
//  the walk that performs a search through it.
//
//  THE MODEL-CHOOSES LAW (the operator's addendum): where the main
//  model's family carries a native search construct (NATIVE_SEARCH_FAMILIES:
//  anthropic · openai), the MODEL sees BOTH doors and chooses per query —
//  the provider's own search as the ProviderSearch tool
//  (tools/WebSearchTool/ProviderSearchTool.ts), and Mercury's vendored
//  WebSearch. The harness never forces one or hides the other; the harness
//  decides only the VENDORED tool's backend. So THIS law is the vendored
//  walk alone (pinned by scripts/search/prove-search-door.ts):
//
//      keyed, if a search key is present (Brave, then Tavily)
//    → else keyless (DuckDuckGo), unless the operator switched it off.
//
//  NEVER CROSS-ACCOUNT, by TYPE: SearchDoor has no native kind — the
//  vendored walk cannot express a provider-account door at all, and the
//  ProviderSearch tool is listed only for the main model's own family
//  (nativeSearchFamilyOf — the one place the routing law is consulted). The
//  keyed and keyless doors spend no model credential of any family.
//
//  MERCURY_SEARCH_BACKEND names ONE vendored door (or 'auto'); a named door
//  that cannot open is the typed no-backend line — never a silent fallback.
//  MERCURY_SEARCH_KEYLESS=0 closes the keyless door (an egress posture).
//
//  THE WALK (performWebSearch): doors in plan order; a door that answers
//  ends the walk; a door that FAILS with a typed outcome falls to the next
//  door with its line kept as a note the result carries. When no door
//  answers, the thrown error is ONE honest line composed of every door's
//  fact. The operator's own cancel propagates as the abort error.
// ============================================================================
import type { ToolUseContext } from '../../Tool.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { AbortError } from '../../utils/errors.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { braveSearch, resolveBraveSearchApiKey, type SearchKeySource } from './brave.js'
import { keylessSearch } from './duckduckgo.js'
import { nativeBackendIdFor, type SearchProgressSink } from './nativeSearch.js'
import { isNativeSearchFamily, type NativeSearchFamily } from './nativeSearchRequest.js'
import {
  failureLine,
  searchBackendLabel,
  searchFailure,
  type SearchBackendId,
  type SearchFailure,
  type SearchHit,
  type SearchOutcome,
  type SearchRequest,
  type SearchTier,
} from './searchContract.js'
import { resolveTavilyApiKey, tavilySearch } from './tavily.js'

/** A vendored door. There is deliberately NO native kind here: the type
 *  cannot express a provider-account door (the cross-account law held
 *  structurally); the provider's own search is the ProviderSearch tool. */
export type SearchDoor =
  | { kind: 'keyed'; backend: 'brave' | 'tavily'; keySource: SearchKeySource }
  | { kind: 'keyless' }

export const SEARCH_BACKEND_OVERRIDES = ['auto', 'brave', 'tavily', 'duckduckgo'] as const
export type SearchBackendOverride = (typeof SEARCH_BACKEND_OVERRIDES)[number]

export interface SearchDoorReads {
  braveKey?: SearchKeySource
  tavilyKey?: SearchKeySource
  /** The raw MERCURY_SEARCH_BACKEND value (unset ⇒ 'auto'). */
  backendOverride?: string
  /** MERCURY_SEARCH_KEYLESS (default on). */
  keylessAllowed: boolean
}

export interface SearchDoorPlan {
  /** The walk order. Empty ⇒ no vendored door can open (see `closed`). */
  doors: SearchDoor[]
  /** Operator-worded facts about doors that are NOT in the walk. */
  closed: string[]
  override: SearchBackendOverride
}

export function parseSearchBackendOverride(raw: string | undefined): SearchBackendOverride | { invalid: string } {
  const word = (raw ?? '').trim().toLowerCase()
  if (word === '') return 'auto'
  return (SEARCH_BACKEND_OVERRIDES as readonly string[]).includes(word) ? (word as SearchBackendOverride) : { invalid: raw ?? '' }
}

/** The main model's native search family, if its wire has one — the ONE
 *  read the ProviderSearch tool's listing and the health fact make. */
export function nativeSearchFamilyOf(mainModel: string): NativeSearchFamily | undefined {
  const route = declaredRouteOf(mainModel)
  return route !== null && isNativeSearchFamily(route) ? route : undefined
}

/** THE VENDORED LAW — pure over injected reads. */
export function resolveSearchDoorPlan(reads: SearchDoorReads): SearchDoorPlan {
  const parsed = parseSearchBackendOverride(reads.backendOverride)
  const closed: string[] = []
  if (typeof parsed !== 'string') {
    return {
      doors: [],
      closed: [`MERCURY_SEARCH_BACKEND='${parsed.invalid}' names no door (takes ${SEARCH_BACKEND_OVERRIDES.join(' · ')})`],
      override: 'auto',
    }
  }
  const keyed: SearchDoor[] = []
  if (reads.braveKey) keyed.push({ kind: 'keyed', backend: 'brave', keySource: reads.braveKey })
  if (reads.tavilyKey) keyed.push({ kind: 'keyed', backend: 'tavily', keySource: reads.tavilyKey })
  const keyless: SearchDoor | undefined = reads.keylessAllowed ? { kind: 'keyless' } : undefined

  if (parsed === 'auto') {
    const doors: SearchDoor[] = [...keyed]
    if (keyed.length === 0) closed.push('no Brave or Tavily key stored (/router key brave · /router key tavily)')
    if (keyless) doors.push(keyless)
    else closed.push('the keyless door is off (MERCURY_SEARCH_KEYLESS=0)')
    return { doors, closed, override: 'auto' }
  }
  if (parsed === 'brave' || parsed === 'tavily') {
    const door = keyed.find(d => d.kind === 'keyed' && d.backend === parsed)
    return door
      ? { doors: [door], closed, override: parsed }
      : { doors: [], closed: [`MERCURY_SEARCH_BACKEND=${parsed}, but no ${searchBackendLabel(parsed)} key is present (${parsed === 'brave' ? 'BRAVE_API_KEY or /router key brave' : 'TAVILY_API_KEY or /router key tavily'})`], override: parsed }
  }
  return keyless
    ? { doors: [keyless], closed, override: parsed }
    : { doors: [], closed: ['MERCURY_SEARCH_BACKEND=duckduckgo, but the keyless door is off (MERCURY_SEARCH_KEYLESS=0)'], override: parsed }
}

/** The live reads (env pins and the secret store). */
export function liveSearchDoorReads(env: Record<string, string | undefined> = process.env): SearchDoorReads {
  return {
    ...(resolveBraveSearchApiKey(env) ? { braveKey: resolveBraveSearchApiKey(env)!.source } : {}),
    ...(resolveTavilyApiKey(env) ? { tavilyKey: resolveTavilyApiKey(env)!.source } : {}),
    ...(flagEnv('MERCURY_SEARCH_BACKEND') !== undefined ? { backendOverride: flagEnv('MERCURY_SEARCH_BACKEND') } : {}),
    keylessAllowed: flagEnabled('MERCURY_SEARCH_KEYLESS'),
  }
}

export function searchDoorLabel(door: SearchDoor): string {
  switch (door.kind) {
    case 'keyed':
      return `${searchBackendLabel(door.backend)} (keyed, ${door.keySource === 'env' ? 'env key' : 'stored key'})`
    case 'keyless':
      return 'DuckDuckGo (keyless)'
  }
}

/** One operator-facing sentence for a vendored plan. */
export function describeSearchDoorPlan(plan: SearchDoorPlan): string {
  const walk = plan.doors.length > 0 ? plan.doors.map(searchDoorLabel).join(' → ') : 'NO door opens'
  const override = plan.override === 'auto' ? '' : ` [MERCURY_SEARCH_BACKEND=${plan.override}]`
  const closed = plan.closed.length > 0 ? ` · not in the walk: ${plan.closed.join('; ')}` : ''
  return `${walk}${override}${closed}`
}

/** The live sentence for a main model — BOTH tools' facts: the
 *  ProviderSearch door when the family has one (model-chosen), and the
 *  vendored walk. Presence and source labels only, never a value. */
export function searchDoorFact(mainModel: string, env: Record<string, string | undefined> = process.env): string {
  const family = nativeSearchFamilyOf(mainModel)
  const native = family ? `ProviderSearch: ${searchBackendLabel(nativeBackendIdFor(family))} (native — the model chooses per query) · ` : ''
  return `${native}WebSearch: ${describeSearchDoorPlan(resolveSearchDoorPlan(liveSearchDoorReads(env)))}`
}

// ── the walk ────────────────────────────────────────────────────────────────

export interface WebSearchRun {
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]
  /** Stream-ordered settlement (one plain group for the vendored doors). */
  sequence: Array<string | { toolUseId: string; hits: SearchHit[] }>
  queries: string[]
  /** The doors tried before the one that answered — one honest line each. */
  notes: string[]
}

export interface WebSearchRunIo {
  context: ToolUseContext
  onProgress?: SearchProgressSink
  /** Proof seams: injected reads and backends (hermetic provers never read
   *  the machine; the live tool leaves them unset). */
  reads?: SearchDoorReads
  backends?: {
    brave?: (request: SearchRequest) => Promise<SearchOutcome>
    tavily?: (request: SearchRequest) => Promise<SearchOutcome>
    keyless?: (request: SearchRequest) => Promise<SearchOutcome>
  }
}

async function openDoor(door: SearchDoor, request: SearchRequest, io: WebSearchRunIo): Promise<SearchOutcome> {
  switch (door.kind) {
    case 'keyed':
      return door.backend === 'brave'
        ? (io.backends?.brave ?? (r => braveSearch(r)))(request)
        : (io.backends?.tavily ?? (r => tavilySearch(r)))(request)
    case 'keyless':
      return (io.backends?.keyless ?? (r => keylessSearch(r)))(request)
  }
}

/** The one line a fully failed walk throws. */
export function walkFailureLine(failures: readonly SearchFailure[], plan: SearchDoorPlan): string {
  if (failures.length === 0) {
    return failureLine(searchFailure('no-backend', 'none', plan.closed.join('; ') || 'no door is configured'))
  }
  const last = failures[failures.length - 1]!
  const earlier = failures.slice(0, -1).map(failureLine)
  const closed = plan.closed.length > 0 ? ` Not in the walk: ${plan.closed.join('; ')}.` : ''
  return `${failureLine(last)}${earlier.length > 0 ? ` (earlier: ${earlier.join(' · ')})` : ''}${closed}`
}

export async function performWebSearch(request: SearchRequest, io: WebSearchRunIo): Promise<WebSearchRun> {
  const reads = io.reads ?? liveSearchDoorReads()
  const plan = resolveSearchDoorPlan(reads)
  const failures: SearchFailure[] = []
  for (const door of plan.doors) {
    const outcome = await openDoor(door, request, io)
    if (outcome.ok) {
      io.onProgress?.({
        toolUseID: `${outcome.via}-1`,
        data: { type: 'search_results_received', resultCount: outcome.hits.length, query: request.query },
      })
      return {
        via: outcome.via,
        tier: outcome.tier,
        hits: outcome.hits,
        sequence: outcome.sequence ?? [{ toolUseId: `${outcome.via}-1`, hits: outcome.hits }],
        queries: outcome.queries ?? [request.query],
        notes: failures.map(failureLine),
      }
    }
    if (outcome.kind === 'aborted' || io.context.abortController.signal.aborted) throw new AbortError()
    failures.push(outcome)
  }
  throw new Error(walkFailureLine(failures, plan))
}
