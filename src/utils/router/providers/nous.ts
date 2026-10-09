import { getCachedProviderDiscovery, primeNousDiscovery } from '../providerDiscovery.js'
import { getCachedNousCatalogue } from '../../../services/providers/nous/nousCatalogue.js'
import type {
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
} from './types.js'

export function describeNousProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('nous') ?? primeNousDiscovery()
  const record = discovery?.provider === 'nous' ? discovery : undefined
  const keyPresent = record?.keyPresent ?? false
  const snapshot = keyPresent ? getCachedNousCatalogue() : null
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: [],
    account: keyPresent
      ? record?.keySource === 'signin'
        ? { kind: 'provider-oauth', label: 'Nous Portal sign-in' }
        : { kind: 'api-key', label: record?.keySource === 'env' ? 'NOUS_API_KEY (env)' : 'Nous Portal API key (stored, auth-scoped)' }
      : { kind: 'none', label: 'no Nous Portal API key detected' },
    catalogue: [],
    ...(snapshot && snapshot.fetchedAtMs > 0
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: snapshot.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function nousStatus(): RouterProviderStatus {
  const discovery = primeNousDiscovery()
  return discovery?.keyPresent ? { available: true } : { available: false, reason: 'no-api-key:nous' }
}

export function listNousModels(): RouterProviderModel[] {
  return []
}

export function resolveNousModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildNousLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error('router: provider nous has no SEAT runtime — roster seats stay Anthropic; Nous Portal models dispatch through the AgentTool engine path')
}

export const nousProviderAdapter: RouterProviderAdapter = {
  id: 'nous',
  transport: 'openai-compat-chat-completions',
  status: nousStatus,
  describe: describeNousProvider,
  listModels: listNousModels,
  resolveModel: resolveNousModel,
  buildLaunchPatch: buildNousLaunchPatch,
}
