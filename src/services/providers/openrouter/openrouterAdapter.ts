import {
  getCachedProviderDiscovery,
  primeOpenrouterDiscovery,
} from '../providerDiscovery.js'
import { getCachedOpenrouterCatalogue } from './openrouterCatalogue.js'
import type {
  ProviderDescription,
  ProviderModelRef,
  ProviderModelClass,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
} from '../providerAdapter.js'

function describeOpenrouterProvider(): ProviderDescription {
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

function openrouterStatus(): ProviderStatus {
  const discovery = primeOpenrouterDiscovery()
  return discovery?.keyPresent
    ? { available: true }
    : { available: false, reason: 'no-api-key:openrouter' }
}

function listOpenrouterModels(): ProviderModel[] {

  return []
}

function resolveOpenrouterModel(
  _modelClass: ProviderModelClass,
): ProviderModelRef | null {
  return null
}

function buildOpenrouterLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error(
    'seat: provider openrouter has no SEAT runtime — roster seats stay Anthropic; OpenRouter dispatch lands with the provider-wire fold',
  )
}

export const openrouterProviderAdapter: ProviderAdapter = {
  id: 'openrouter',
  transport: 'openrouter-chat-completions',
  status: openrouterStatus,
  describe: describeOpenrouterProvider,
  listModels: listOpenrouterModels,
  resolveModel: resolveOpenrouterModel,
  buildLaunchPatch: buildOpenrouterLaunchPatch,
}
