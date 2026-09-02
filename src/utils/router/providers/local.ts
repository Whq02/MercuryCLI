// ============================================================================
//  providers/local.ts — the locally-served RouterProviderAdapter. The same
//  laws as the other engine adapters: availability is DISCOVERY truth (a
//  server answered); SEATS STAY ANTHROPIC (resolveModel null /
//  buildLaunchPatch throws); the optional key value never enters this
//  surface. Catalogue: the discovered models only ('live-discovery' with
//  the probe stamp) — there is no static list of someone's local box.
// ============================================================================
import { getCachedProviderDiscovery, primeLocalDiscovery } from '../providerDiscovery.js'
import { cachedLocalModels, getCachedLocalDiscovery } from '../../../services/providers/local/localDiscovery.js'
import { LOCAL_MODEL_PREFIX } from '../../../services/providers/local/localCatalogue.js'
import type {
  ProviderCatalogueEntry,
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
  SpecialistRole,
} from './types.js'
import { SPECIALIST_ROLES } from './types.js'

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

/** The discovered models as specialist entries. A model that declares no
 *  tool support is still listed (the dispatch refuses tool-bearing turns
 *  honestly) — role eligibility here states the family's reach, and the
 *  per-model capability rides the discovery record. */
export function localLiveCatalogue(): ProviderCatalogueEntry[] {
  return cachedLocalModels().map(record => ({
    id: `${LOCAL_MODEL_PREFIX}${record.id}`,
    displayLabel: record.displayName ?? record.id,
    modelClass: 'local' as const,
    ...(record.contextWindow ? { contextWindow: record.contextWindow.tokens } : {}),
    efforts: [],
    roles: record.toolsDeclared === false ? [] : ALL_ROLES,
  }))
}

export function describeLocalProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('local') ?? primeLocalDiscovery()
  const record = discovery?.provider === 'local' ? discovery : undefined
  const snapshot = getCachedLocalDiscovery()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: ALL_ROLES,
    account: record?.serverPresent
      ? record.keyPresent
        ? { kind: 'api-key', label: record.label ?? 'local server · key' }
        : { kind: 'keyless', label: record.label ?? 'local server (keyless)' }
      : record !== undefined && !record.probed
        ? {
            // The honest not-probed stamp (w1-f14-03): absence has not been
            // established this run — say the probe is pending, never paint
            // a fabricated fresh 'no server'.
            kind: 'none',
            label: 'local servers not probed yet (Ollama :11434 · LM Studio :1234 · vLLM :8000 · llama.cpp :8080)',
          }
        : {
            kind: 'none',
            label: 'no local server discovered (Ollama :11434 · LM Studio :1234 · vLLM :8000 · llama.cpp :8080)',
          },
    catalogue: localLiveCatalogue(),
    ...(snapshot
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: snapshot.probedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function localStatus(): RouterProviderStatus {
  const discovery = primeLocalDiscovery()
  if (discovery?.serverPresent) return { available: true }
  // Never-probed ≠ probed-and-absent (the never-stale law, w1-f14-03):
  // before the first bounded discovery this process cannot honestly claim
  // absence — 'discovery-pending' is the health grammar's own stable code
  // for exactly this state.
  if (discovery !== null && !discovery.probed) {
    return { available: false, reason: 'discovery-pending:local' }
  }
  return { available: false, reason: 'no-server:local' }
}

export function listLocalModels(): RouterProviderModel[] {
  if (!localStatus().available) return []
  return localLiveCatalogue().map(entry => ({
    ref: {
      provider: 'local' as const,
      model: entry.id,
      modelClass: 'local' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveLocalModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildLocalLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider local has no SEAT runtime — party/roster seats stay Anthropic; local specialists dispatch through the AgentTool engine path',
  )
}

export const localProviderAdapter: RouterProviderAdapter = {
  id: 'local',
  transport: 'openai-compat-chat-completions',
  status: localStatus,
  describe: describeLocalProvider,
  listModels: listLocalModels,
  resolveModel: resolveLocalModel,
  buildLaunchPatch: buildLocalLaunchPatch,
}
