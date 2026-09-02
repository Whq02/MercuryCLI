import {
  getCachedProviderDiscovery,
  primeGeminiDiscovery,
} from '../providerDiscovery.js'
import { getCachedGeminiCatalogue } from '../../../services/providers/gemini/geminiCatalogue.js'
import type {
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
} from './types.js'

export function describeGeminiProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('gemini') ?? primeGeminiDiscovery()
  const record = discovery?.provider === 'gemini' ? discovery : undefined
  const account = record?.account
  const snapshot = account
    ? getCachedGeminiCatalogue(account.kind === 'oauth' ? 'oauth' : 'api-key')
    : null
  return {
    transport: 'gemini-generate-content',
    capabilities: ['usage-accounting'],
    roles: [],
    account: account
      ? account.kind === 'oauth'
        ? { kind: 'provider-oauth', label: account.label }
        : { kind: 'api-key', label: account.label }
      : { kind: 'none', label: 'no Gemini credential detected' },
    catalogue: [],
    ...(snapshot && snapshot.fetchedAtMs > 0
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: snapshot.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function geminiStatus(): RouterProviderStatus {
  const discovery = primeGeminiDiscovery()
  return discovery?.account
    ? { available: true }
    : { available: false, reason: 'no-account:gemini' }
}

export function listGeminiModels(): RouterProviderModel[] {
  return []
}

export function resolveGeminiModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  return null
}

export function buildGeminiLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider gemini has no SEAT runtime — party/roster seats stay Anthropic; Gemini dispatch lands with the provider-wire fold',
  )
}

export const geminiProviderAdapter: RouterProviderAdapter = {
  id: 'gemini',
  transport: 'gemini-generate-content',
  status: geminiStatus,
  describe: describeGeminiProvider,
  listModels: listGeminiModels,
  resolveModel: resolveGeminiModel,
  buildLaunchPatch: buildGeminiLaunchPatch,
}
