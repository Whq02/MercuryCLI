import {
  getCachedProviderDiscovery,
  primeGeminiDiscovery,
} from '../providerDiscovery.js'
import { getCachedGeminiCatalogue } from './geminiCatalogue.js'
import type {
  ProviderDescription,
  ProviderModelRef,
  ProviderModelClass,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
} from '../providerAdapter.js'

function describeGeminiProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('gemini') ?? primeGeminiDiscovery()
  const record = discovery?.provider === 'gemini' ? discovery : undefined
  const account = record?.account
  const snapshot = account
    ? getCachedGeminiCatalogue(account.kind)
    : null
  return {
    transport: 'gemini-generate-content',
    capabilities: ['usage-accounting'],
    roles: [],
    account: account
      ? account.kind === 'oauth' || account.kind === 'plan'
        ? { kind: 'provider-oauth', label: account.label }
        : { kind: 'api-key', label: account.label }
      : { kind: 'none', label: 'no Gemini credential detected' },
    catalogue: [],
    ...(snapshot && snapshot.fetchedAtMs > 0
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: snapshot.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

function geminiStatus(): ProviderStatus {
  const discovery = primeGeminiDiscovery()
  return discovery?.account
    ? { available: true }
    : { available: false, reason: 'no-account:gemini' }
}

function listGeminiModels(): ProviderModel[] {

  return []
}

function resolveGeminiModel(
  _modelClass: ProviderModelClass,
): ProviderModelRef | null {
  return null
}

function buildGeminiLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error(
    'seat: provider gemini has no SEAT runtime — roster seats stay Anthropic; Gemini dispatch lands with the provider-wire fold',
  )
}

export const geminiProviderAdapter: ProviderAdapter = {
  id: 'gemini',
  transport: 'gemini-generate-content',
  status: geminiStatus,
  describe: describeGeminiProvider,
  listModels: listGeminiModels,
  resolveModel: resolveGeminiModel,
  buildLaunchPatch: buildGeminiLaunchPatch,
}
