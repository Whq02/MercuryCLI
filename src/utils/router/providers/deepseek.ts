// ============================================================================
//  providers/deepseek.ts — the DeepSeek RouterProviderAdapter.
// The zai adapter's laws: availability is credential truth
//  alone; SEATS STAY ANTHROPIC; the key value never enters this surface.
//  Catalogue: dated static pins (deepseekPins — the official pricing page's
//  three served models, fetched).
// ============================================================================
import { getCachedProviderDiscovery, primeDeepseekDiscovery } from '../providerDiscovery.js'
import {
  DEEPSEEK_DISPLAY_PINS,
  DEEPSEEK_EFFORTS,
} from '../../../services/providers/deepseek/deepseekPins.js'
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

export const DEEPSEEK_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] =
  DEEPSEEK_DISPLAY_PINS.map(pin => ({
    id: pin.id,
    displayLabel: pin.displayName,
    modelClass: 'deepseek' as const,
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    efforts: [...DEEPSEEK_EFFORTS],
    roles: ALL_ROLES,
  }))

export function describeDeepseekProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('deepseek')
  const record = discovery?.provider === 'deepseek' ? discovery : undefined
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
    account: record?.keyPresent
      ? {
          kind: 'api-key',
          label:
            record.keySource === 'stored'
              ? 'DeepSeek API key (stored, auth-scoped)'
              : 'DEEPSEEK_API_KEY (env)',
        }
      : { kind: 'none', label: 'no DeepSeek API key detected' },
    catalogue: DEEPSEEK_STATIC_CATALOGUE,
    catalogueSource: 'static-pin',
  }
}

export function deepseekStatus(): RouterProviderStatus {
  const discovery = primeDeepseekDiscovery()
  return discovery?.keyPresent
    ? { available: true }
    : { available: false, reason: 'no-api-key:deepseek' }
}

export function listDeepseekModels(): RouterProviderModel[] {
  if (!deepseekStatus().available) return []
  return DEEPSEEK_STATIC_CATALOGUE.map(entry => ({
    ref: {
      provider: 'deepseek' as const,
      model: entry.id,
      modelClass: 'deepseek' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveDeepseekModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  // SEATS STAY ANTHROPIC (the zai adapter's law, held verbatim).
  return null
}

export function buildDeepseekLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider deepseek has no SEAT runtime — roster seats stay Anthropic; DeepSeek specialists dispatch through the AgentTool engine path',
  )
}

export const deepseekProviderAdapter: RouterProviderAdapter = {
  id: 'deepseek',
  transport: 'openai-compat-chat-completions',
  status: deepseekStatus,
  describe: describeDeepseekProvider,
  listModels: listDeepseekModels,
  resolveModel: resolveDeepseekModel,
  buildLaunchPatch: buildDeepseekLaunchPatch,
}
