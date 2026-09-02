// ============================================================================
//  providers/openrouter.ts — the OpenRouter RouterProviderAdapter
//
//
//  The AUTH/wallet/catalogue estate is LIVE (openrouterAccounts +
//  openrouterCatalogue + openrouterUsageState); the DISPATCH wire is the
//  provider-wire fold's (openrouterDispatchReady probes the real routing
//  law). This adapter reports honest lane truth:
//    - status() = credential presence (self-primed — env/file reads only):
//      available:true with any OpenRouter key (env > OAuth-minted > stored),
//      else the stable code 'no-api-key:openrouter'.
//    - describe() = the account view + LIVE catalogue provenance. The
//      specialist/seat catalogue stays EMPTY: OpenRouter's 400+ vendor-mixed
//      models never enter the seat estate by guesswork — the /model picker
//      derives its rows from openrouterCatalogue directly, and seats stay
//      with providers whose runtimes exist.
//    - SEATS STAY ANTHROPIC: resolveModel stays null and buildLaunchPatch
//      keeps throwing (the zai precedent — no OpenRouter seat runtime).
//  The key value never enters this surface.
// ============================================================================
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
    // No engine runtime exists on this lane yet (the provider-wire fold owns
    // it) — advertising stream/tool capabilities here would claim a disabled
    // capability. The auth estate itself carries usage accounting.
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
  // Route-fabric listing feeds SEAT resolution — no OpenRouter seat runtime
  // exists, so this stays empty (the /model picker reads the live catalogue
  // through openrouterCatalogue, not this seam).
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
