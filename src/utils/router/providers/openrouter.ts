import {
  getCachedProviderDiscovery,
  primeOpenrouterDiscovery,
} from '../providerDiscovery.js'
import { getCachedOpenrouterCatalogue } from '../../../services/providers/openrouter/openrouterCatalogue.js'
import type {
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
} from './types.js'

export function describeOpenrouterProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('openrouter') ?? primeOpenrouterDiscovery()
  const record = discovery?.provider === 'openrouter' ? discovery : undefined
  const keyPresent = record?.keyPresent ?? false
  const keySource = record?.keySource
  const snapshot = keySource ? getCachedOpenrouterCatalogue(keySource) : null
  return {
    transport: 'openrouter-chat-completions',
    capabilities: ['usage-accounting'],
    roles: [],
    account: keyPresent
      ? {
          kind: 'api-key',
          label:
            keySource === 'oauth'
              ? 'OpenRouter (OAuth-minted key)'
              : keySource === 'env'
                ? 'OPENROUTER_API_KEY (env)'
                : 'OpenRouter API key (stored, auth-scoped)',
        }
      : { kind: 'none', label: 'no OpenRouter credential detected' },
    catalogue: [],
    ...(snapshot && snapshot.fetchedAtMs > 0
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: snapshot.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function openrouterStatus(): RouterProviderStatus {
  const discovery = primeOpenrouterDiscovery()
  return discovery?.keyPresent
    ? { available: true }
    : { available: false, reason: 'no-api-key:openrouter' }
}

export function listOpenrouterModels(): RouterProviderModel[] {
  return []
}

export function resolveOpenrouterModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  return null
}

export function buildOpenrouterLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider openrouter has no SEAT runtime — roster seats stay Anthropic; OpenRouter dispatch lands with the provider-wire fold',
  )
}

export const openrouterProviderAdapter: RouterProviderAdapter = {
  id: 'openrouter',
  transport: 'openrouter-chat-completions',
  status: openrouterStatus,
  describe: describeOpenrouterProvider,
  listModels: listOpenrouterModels,
  resolveModel: resolveOpenrouterModel,
  buildLaunchPatch: buildOpenrouterLaunchPatch,
}
