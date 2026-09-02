import { getCachedProviderDiscovery, primeCompatDiscovery } from '../providerDiscovery.js'
import {
  compatSlotModelIds,
  resolveCompatSlotConfig,
} from '../../../services/providers/openaicompat/compatAccounts.js'
import { stripCompatModelPrefix } from '../../../services/providers/routeLaw.js'
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

export function compatSlotCatalogue(): readonly ProviderCatalogueEntry[] {
  return compatSlotModelIds().map(id => ({
    id,
    displayLabel: stripCompatModelPrefix(id),
    modelClass: 'compat' as const,
    efforts: [],
    roles: ALL_ROLES,
  }))
}

export function describeCompatProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('openai-compat')
  const record = discovery?.provider === 'openai-compat' ? discovery : undefined
  const label = record?.label ?? resolveCompatSlotConfig()?.label ?? 'Custom endpoint'
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: ALL_ROLES,
    account: !record?.configured
      ? { kind: 'none', label: 'no endpoint configured (MERCURY_COMPAT_BASE_URL)' }
      : record.keyPresent
        ? {
            kind: 'api-key',
            label:
              record.keySource === 'stored'
                ? `${label} — API key (stored, auth-scoped)`
                : `${label} — MERCURY_COMPAT_API_KEY (env)`,
          }
        : { kind: 'keyless', label: `${label} — no key (local/auth-free endpoint)` },
    catalogue: compatSlotCatalogue(),
    catalogueSource: 'static-pin',
  }
}

export function compatStatus(): RouterProviderStatus {
  const discovery = primeCompatDiscovery()
  return discovery?.configured
    ? { available: true }
    : { available: false, reason: 'not-configured:openai-compat' }
}

export function listCompatModels(): RouterProviderModel[] {
  if (!compatStatus().available) return []
  return compatSlotCatalogue().map(entry => ({
    ref: {
      provider: 'openai-compat' as const,
      model: entry.id,
      modelClass: 'compat' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveCompatModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  return null
}

export function buildCompatLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: the openai-compat slot has no SEAT runtime — roster seats stay Anthropic; compat specialists dispatch through the AgentTool engine path',
  )
}

export const compatProviderAdapter: RouterProviderAdapter = {
  id: 'openai-compat',
  transport: 'openai-compat-chat-completions',
  status: compatStatus,
  describe: describeCompatProvider,
  listModels: listCompatModels,
  resolveModel: resolveCompatModel,
  buildLaunchPatch: buildCompatLaunchPatch,
}
