// ============================================================================
//  providers/moonshot.ts — the Moonshot/Kimi RouterProviderAdapter (provider
// -08-21). The zai adapter's laws: availability is credential truth
//  alone; SEATS STAY ANTHROPIC (resolveModel null / buildLaunchPatch throws —
//  engine specialists dispatch through the AgentTool/callModel path against
//  describe().catalogue); the key value never enters this surface.
//
//  Catalogue: STATIC PINS (platform.kimi.ai documents no /models list
//  endpoint — checked), each entry a dated observation from
//  kimiPins; kimi-k3 is the flagship (1,048,576-token context documented).
// ============================================================================
import { getCachedProviderDiscovery, primeMoonshotDiscovery } from '../providerDiscovery.js'
import {
  KIMI_DISPLAY_PINS,
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

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

export const KIMI_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = KIMI_DISPLAY_PINS.map(
  pin => ({
    id: pin.id,
    displayLabel: pin.displayName,
    modelClass: 'kimi' as const,
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    efforts: KIMI_EFFORT_MODELS.has(pin.id) ? [...KIMI_EFFORTS] : [],
    roles: ALL_ROLES,
  }),
)

export function describeMoonshotProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('moonshot')
  const record = discovery?.provider === 'moonshot' ? discovery : undefined
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
    // The OWNING resolver's account (env key > Kimi sign-in > stored key),
    // carried on the discovery record — one truth for every surface.
    account: record?.account
      ? record.account.kind === 'kimi-oauth'
        ? { kind: 'provider-oauth', label: record.account.label }
        : { kind: 'api-key', label: record.account.label }
      : { kind: 'none', label: 'no Kimi sign-in or Moonshot API key detected' },
    catalogue: KIMI_STATIC_CATALOGUE,
    catalogueSource: 'static-pin',
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
  return KIMI_STATIC_CATALOGUE.map(entry => ({
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
  // SEATS STAY ANTHROPIC (the zai adapter's law, held verbatim).
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
