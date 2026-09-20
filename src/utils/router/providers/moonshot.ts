import { getCachedProviderDiscovery, primeMoonshotDiscovery } from '../providerDiscovery.js'
import {
  KIMI_EFFORTS,
  KIMI_EFFORT_MODELS,
} from '../../../services/providers/moonshot/kimiPins.js'
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
import { moonshotCatalogueRows } from '../../../services/providers/moonshot/moonshotCatalogue.js'

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

export function moonshotCatalogueEntries(): ProviderCatalogueEntry[] {
  return moonshotCatalogueRows().rows.map(row => ({
    id: row.id,
    displayLabel: row.displayName,
    modelClass: 'kimi' as const,
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: KIMI_EFFORT_MODELS.has(row.id) ? [...KIMI_EFFORTS] : [],
    roles: ALL_ROLES,
  }))
}

export function describeMoonshotProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('moonshot')
  const record = discovery?.provider === 'moonshot' ? discovery : undefined
  const { source } = moonshotCatalogueRows()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: [
      'streaming',
      'tool-calls',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: ALL_ROLES,
    account: record?.account
      ? record.account.kind === 'kimi-oauth'
        ? { kind: 'provider-oauth', label: record.account.label }
        : { kind: 'api-key', label: record.account.label }
      : { kind: 'none', label: 'no Kimi sign-in or Moonshot API key detected' },
    catalogue: moonshotCatalogueEntries(),
    ...(source.kind === 'live'
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: source.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function moonshotStatus(): RouterProviderStatus {
  const discovery = primeMoonshotDiscovery()
  return discovery?.account
    ? { available: true }
    : { available: false, reason: 'no-credential:moonshot' }
}

export function listMoonshotModels(): RouterProviderModel[] {
  if (!moonshotStatus().available) return []
  return moonshotCatalogueEntries().map(entry => ({
    ref: {
      provider: 'moonshot' as const,
      model: entry.id,
      modelClass: 'kimi' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveMoonshotModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  return null
}

export function buildMoonshotLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider moonshot has no SEAT runtime — roster seats stay Anthropic; Kimi specialists dispatch through the AgentTool engine path',
  )
}

export const moonshotProviderAdapter: RouterProviderAdapter = {
  id: 'moonshot',
  transport: 'openai-compat-chat-completions',
  status: moonshotStatus,
  describe: describeMoonshotProvider,
  listModels: listMoonshotModels,
  resolveModel: resolveMoonshotModel,
  buildLaunchPatch: buildMoonshotLaunchPatch,
}
