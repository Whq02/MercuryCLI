import { getCachedProviderDiscovery, primeCompatDiscovery } from '../providerDiscovery.js'
import {
  compatSlotModelIds,
  resolveCompatAccount,
  resolveCompatSlotConfig,
} from './compatAccounts.js'
import { stripCompatModelPrefix } from '../routeLaw.js'
import { compatContextWindowFor } from './compatCatalogue.js'
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

function compatSlotCatalogue(): readonly ProviderCatalogueEntry[] {
  return compatSlotModelIds().map(id => ({
    id,
    displayLabel: stripCompatModelPrefix(id),
    contextWindow: compatContextWindowFor(id),
    modelClass: 'compat' as const,
    efforts: [],
    roles: ALL_ROLES,
  }))
}

function describeCompatProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('openai-compat')
  const record = discovery?.provider === 'openai-compat' ? discovery : undefined
  const account = record?.configured ? resolveCompatAccount() : undefined
  const label = record?.label ?? resolveCompatSlotConfig()?.label ?? 'Custom endpoint'
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: ALL_ROLES,
    account: !record?.configured
      ? { kind: 'none', label: 'no endpoint configured (MERCURY_COMPAT_BASE_URL)' }
      : account ?? (record.keyPresent
        ? {
            kind: 'api-key',
            label:
              record.keySource === 'stored'
                ? `${label} — API key (stored, auth-scoped)`
                : `${label} — MERCURY_COMPAT_API_KEY (env)`,
          }
        : { kind: 'keyless', label: `${label} — no key (local/auth-free endpoint)` }),
    catalogue: compatSlotCatalogue(),
    catalogueSource: 'static-pin',
  }
}

function compatStatus(): ProviderStatus {
  const discovery = primeCompatDiscovery()
  return discovery?.configured
    ? { available: true }
    : { available: false, reason: 'not-configured:openai-compat' }
}

function listCompatModels(): ProviderModel[] {
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

function resolveCompatModel(
  _modelClass: ProviderModelClass,
): ProviderModelRef | null {
  return null
}

function buildCompatLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error(
    'seat: the openai-compat slot has no SEAT runtime — roster seats stay Anthropic; compat specialists dispatch through the AgentTool engine path',
  )
}

export const compatProviderAdapter: ProviderAdapter = {
  id: 'openai-compat',
  transport: 'openai-compat-chat-completions',
  status: compatStatus,
  describe: describeCompatProvider,
  listModels: listCompatModels,
  resolveModel: resolveCompatModel,
  buildLaunchPatch: buildCompatLaunchPatch,
}
