import { getCachedProviderDiscovery, primeZaiDiscovery } from '../providerDiscovery.js'
import { GLM_STATIC_FLOOR_IDS, glmDisplayPin, glmEffortsFor } from '../../../services/providers/zai/glmPins.js'
import { zaiCatalogueRows } from '../../../services/providers/zai/zaiCatalogue.js'
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

function entryOf(row: { id: string; displayName: string; contextWindow?: number }): ProviderCatalogueEntry {
  return {
    id: row.id,
    displayLabel: row.displayName,
    modelClass: 'glm' as const,
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...(glmEffortsFor(row.id) ?? [])],
    roles: ALL_ROLES,
  }
}

export const GLM_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = GLM_STATIC_FLOOR_IDS.flatMap(id => {
  const pin = glmDisplayPin(id)
  return pin ? [entryOf(pin)] : []
})

export function zaiLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = zaiCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(entryOf) }
}

export function zaiCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return zaiLiveCatalogue()?.entries ?? GLM_STATIC_CATALOGUE
}

export function zaiCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  const wanted = id.trim().toLowerCase()
  return zaiCatalogueEntries().find(entry => entry.id === wanted)
}

export function describeZaiProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('zai')
  const keyPresent = discovery?.provider === 'zai' ? discovery.keyPresent : false
  const live = zaiLiveCatalogue()
  return {
    transport: 'zai-chat-completions',
    capabilities: [
      'streaming',
      'tool-calls',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: ALL_ROLES,
    account: keyPresent
      ? {
          kind: 'api-key',
          label:
            discovery?.provider === 'zai' && discovery.keySource === 'stored'
              ? discovery.keyPlan === 'coding'
                ? 'GLM Coding Plan key (stored, auth-scoped)'
                : 'Z.AI API key (stored, auth-scoped)'
              : 'ZAI_API_KEY (env)',
        }
      : { kind: 'none', label: 'no Z.AI API key detected' },
    catalogue: live?.entries ?? GLM_STATIC_CATALOGUE,
    ...(live
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function zaiStatus(): RouterProviderStatus {
  const discovery = primeZaiDiscovery()
  return discovery?.keyPresent
    ? { available: true }
    : { available: false, reason: 'no-api-key:zai' }
}

export function listZaiModels(): RouterProviderModel[] {
  if (!zaiStatus().available) return []
  return zaiCatalogueEntries().map(entry => ({
    ref: {
      provider: 'zai' as const,
      model: entry.id,
      modelClass: 'glm' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveZaiModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  return null
}

export function buildZaiLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider zai has no SEAT runtime — roster seats stay Anthropic; GLM specialists dispatch through the AgentTool engine path',
  )
}

export const zaiProviderAdapter: RouterProviderAdapter = {
  id: 'zai',
  transport: 'zai-chat-completions',
  status: zaiStatus,
  describe: describeZaiProvider,
  listModels: listZaiModels,
  resolveModel: resolveZaiModel,
  buildLaunchPatch: buildZaiLaunchPatch,
}
