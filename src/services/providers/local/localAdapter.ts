import { getCachedProviderDiscovery, primeLocalDiscovery } from '../providerDiscovery.js'
import { cachedLocalModels, getCachedLocalDiscovery } from './localDiscovery.js'
import { LOCAL_MODEL_PREFIX } from './localCatalogue.js'
import type {
  ProviderCatalogueEntry,
  ProviderDescription,
  ProviderModelRef,
  ProviderModelClass,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  SpecialistRole,
} from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

export function localLiveCatalogue(): ProviderCatalogueEntry[] {
  return cachedLocalModels().map(record => ({
    id: `${LOCAL_MODEL_PREFIX}${record.id}`,
    displayLabel: record.displayName ?? record.id,
    modelClass: 'local' as const,
    ...(record.contextWindow ? { contextWindow: record.contextWindow.tokens } : {}),
    efforts: record.thinking?.values.filter((value): value is string => typeof value === 'string') ?? [],
    ...(record.executionOrigin !== undefined ? { executionOrigin: record.executionOrigin } : {}),
    roles: ALL_ROLES,
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

export function localStatus(): ProviderStatus {
  const discovery = primeLocalDiscovery()
  if (discovery?.serverPresent) return { available: true }
  if (discovery !== null && !discovery.probed) {
    return { available: false, reason: 'discovery-pending:local' }
  }
  return { available: false, reason: 'no-server:local' }
}

function listLocalModels(): ProviderModel[] {
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

function resolveLocalModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildLocalLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error(
    'seat: provider local has no SEAT runtime — roster seats stay Anthropic; local specialists dispatch through the AgentTool engine path',
  )
}

export const localProviderAdapter: ProviderAdapter = {
  id: 'local',
  transport: 'openai-compat-chat-completions',
  status: localStatus,
  describe: describeLocalProvider,
  listModels: listLocalModels,
  resolveModel: resolveLocalModel,
  buildLaunchPatch: buildLocalLaunchPatch,
}
