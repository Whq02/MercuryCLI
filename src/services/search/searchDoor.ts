import type { ToolUseContext } from '../../Tool.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { PROVIDER_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import { AbortError } from '../../utils/errors.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import { braveSearch, resolveBraveSearchApiKey, type SearchKeySource } from './brave.js'
import { keylessSearch } from './duckduckgo.js'
import { nativeBackendIdFor, type SearchProgressSink } from './nativeSearch.js'
import { isNativeSearchFamily, type NativeSearchFamily } from './nativeSearchRequest.js'
import {
  cachedAnswerNote,
  coolDownRemainingMs,
  liveSearchClock,
  nextSearchGroupId,
  noteAnswered,
  noteRateLimited,
  rememberSearch,
  secondsLeftLabel,
  takeCachedSearch,
  takeKeyedDoorHint,
  type SearchClock,
} from './searchPacing.js'
import {
  failureLine,
  KEYED_DOOR_COMMANDS,
  KEYED_DOOR_FREE_TIER,
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

export type SearchDoor =
  | { kind: 'keyed'; backend: 'brave' | 'tavily'; keySource: SearchKeySource }
  | { kind: 'keyless' }

export const SEARCH_BACKEND_OVERRIDES = ['auto', 'brave', 'tavily', 'duckduckgo'] as const
export type SearchBackendOverride = (typeof SEARCH_BACKEND_OVERRIDES)[number]

export interface SearchDoorReads {
  braveKey?: SearchKeySource
  tavilyKey?: SearchKeySource
  backendOverride?: string
  keylessAllowed: boolean
}

export interface SearchDoorPlan {
  doors: SearchDoor[]
  closed: string[]
  override: SearchBackendOverride
}

export function parseSearchBackendOverride(raw: string | undefined): SearchBackendOverride | { invalid: string } {
  const word = (raw ?? '').trim().toLowerCase()
  if (word === '') return 'auto'
  return (SEARCH_BACKEND_OVERRIDES as readonly string[]).includes(word) ? (word as SearchBackendOverride) : { invalid: raw ?? '' }
}

export function nativeSearchFamilyOf(mainModel: string): NativeSearchFamily | undefined {
  const route = declaredRouteOf(mainModel)
  return route !== null && isNativeSearchFamily(route) ? route : undefined
}

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
    if (keyed.length === 0) closed.push(`no Brave or Tavily key stored (${KEYED_DOOR_COMMANDS} — ${KEYED_DOOR_FREE_TIER})`)
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

export function describeSearchDoorPlan(plan: SearchDoorPlan): string {
  const walk = plan.doors.length > 0 ? plan.doors.map(searchDoorLabel).join(' → ') : 'NO door opens'
  const override = plan.override === 'auto' ? '' : ` [MERCURY_SEARCH_BACKEND=${plan.override}]`
  const closed = plan.closed.length > 0 ? ` · not in the walk: ${plan.closed.join('; ')}` : ''
  return `${walk}${override}${closed}`
}

export function searchDoorFact(mainModel: string, env: Record<string, string | undefined> = process.env): string {
  const family = nativeSearchFamilyOf(mainModel)
  const native = family ? `ProviderSearch: ${searchBackendLabel(nativeBackendIdFor(family))} (native — the model chooses per query) · ` : ''
  return `${native}WebSearch: ${describeSearchDoorPlan(resolveSearchDoorPlan(liveSearchDoorReads(env)))}`
}


export interface WebSearchRun {
  via: SearchBackendId
  tier: SearchTier
  hits: SearchHit[]
  sequence: Array<string | { toolUseId: string; hits: SearchHit[] }>
  queries: string[]
  notes: string[]
  hint?: string
  cached?: boolean
}

export interface WebSearchRunIo {
  context: ToolUseContext
  onProgress?: SearchProgressSink
  reads?: SearchDoorReads
  backends?: {
    brave?: (request: SearchRequest) => Promise<SearchOutcome>
    tavily?: (request: SearchRequest) => Promise<SearchOutcome>
    keyless?: (request: SearchRequest) => Promise<SearchOutcome>
  }
  clock?: SearchClock
}

async function openDoor(door: SearchDoor, request: SearchRequest, io: WebSearchRunIo, clock: SearchClock): Promise<SearchOutcome> {
  switch (door.kind) {
    case 'keyed':
      return door.backend === 'brave'
        ? (io.backends?.brave ?? (r => braveSearch(r)))(request)
        : (io.backends?.tavily ?? (r => tavilySearch(r)))(request)
    case 'keyless':
      return (io.backends?.keyless ?? (r => keylessSearch(r, { clock })))(request)
  }
}

export interface WalkFailureContext {
  nativeFamily?: NativeSearchFamily
}

export function walkFailureLine(failures: readonly SearchFailure[], plan: SearchDoorPlan, walk: WalkFailureContext = {}): string {
  const native = walk.nativeFamily
    ? ` ${PROVIDER_SEARCH_TOOL_NAME} (${searchBackendLabel(nativeBackendIdFor(walk.nativeFamily))}, the provider's own search) is listed for this session — the other door.`
    : ''
  if (failures.length === 0) {
    return `${failureLine(searchFailure('no-backend', 'none', plan.closed.join('; ') || 'no door is configured'))}${native}`
  }
  const last = failures[failures.length - 1]!
  const earlier = failures.slice(0, -1).map(failureLine)
  const closed = plan.closed.length > 0 ? ` Not in the walk: ${plan.closed.join('; ')}.` : ''
  return `${failureLine(last)}${earlier.length > 0 ? ` (earlier: ${earlier.join(' · ')})` : ''}${closed}${native}`
}

function coolingKeyedFailure(backend: 'brave' | 'tavily', leftMs: number): SearchFailure {
  return searchFailure('rate-limited', backend, `cooling down after a rate limit — ${secondsLeftLabel(leftMs)} left; not knocked`)
}

export async function performWebSearch(request: SearchRequest, io: WebSearchRunIo): Promise<WebSearchRun> {
  const clock = io.clock ?? liveSearchClock
  const reads = io.reads ?? liveSearchDoorReads()
  const plan = resolveSearchDoorPlan(reads)
  const mainModel = (io.context.options.mainLoopModel as string | undefined) || getMainLoopModel()
  const hasKeyedDoor = plan.doors.some(door => door.kind === 'keyed')
  const report = (toolUseID: string, resultCount: number): void => {
    io.onProgress?.({ toolUseID, data: { type: 'search_results_received', resultCount, query: request.query } })
  }

  const cached = takeCachedSearch(request, clock.now())
  if (cached) {
    const toolUseId = nextSearchGroupId(cached.via)
    report(toolUseId, cached.hits.length)
    return {
      via: cached.via,
      tier: cached.tier,
      hits: [...cached.hits],
      sequence: [{ toolUseId, hits: [...cached.hits] }],
      queries: [...cached.queries],
      notes: [cachedAnswerNote(searchBackendLabel(cached.via))],
      cached: true,
    }
  }

  const failures: SearchFailure[] = []
  for (const door of plan.doors) {
    if (door.kind === 'keyed') {
      const left = coolDownRemainingMs(door.backend, clock.now())
      if (left > 0) {
        failures.push(coolingKeyedFailure(door.backend, left))
        continue
      }
    }
    const outcome = await openDoor(door, request, io, clock)
    if (outcome.ok) {
      if (door.kind === 'keyed') noteAnswered(door.backend)
      const queries = outcome.queries ?? [request.query]
      rememberSearch(request, { via: outcome.via, tier: outcome.tier, hits: outcome.hits, queries }, clock.now())
      const toolUseId = nextSearchGroupId(outcome.via)
      report(toolUseId, outcome.hits.length)
      const hint = outcome.tier === 'keyless' && !hasKeyedDoor ? takeKeyedDoorHint() : undefined
      return {
        via: outcome.via,
        tier: outcome.tier,
        hits: outcome.hits,
        sequence: outcome.sequence ?? [{ toolUseId, hits: outcome.hits }],
        queries,
        notes: [...failures.map(failureLine), ...(outcome.notes ?? [])],
        ...(hint ? { hint } : {}),
      }
    }
    if (outcome.kind === 'aborted' || io.context.abortController.signal.aborted) throw new AbortError()
    if (door.kind === 'keyed' && outcome.kind === 'rate-limited') noteRateLimited(door.backend, clock)
    failures.push(outcome)
  }
  if (!hasKeyedDoor) takeKeyedDoorHint()
  throw new Error(walkFailureLine(failures, plan, { nativeFamily: nativeSearchFamilyOf(mainModel) }))
}
