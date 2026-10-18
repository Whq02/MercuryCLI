import { getCachedProviderDiscovery, primeNousDiscovery } from '../providerDiscovery.js'
import { getCachedNousCatalogue } from './nousCatalogue.js'
import type {
  ProviderDescription,
  ProviderModelRef,
  ProviderModelClass,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
} from '../providerAdapter.js'

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

export function nousStatus(): ProviderStatus {
  const discovery = primeNousDiscovery()
  return discovery?.keyPresent ? { available: true } : { available: false, reason: 'no-api-key:nous' }
}

export function listNousModels(): ProviderModel[] {
  return []
}

export function resolveNousModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

export function buildNousLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider nous has no SEAT runtime — roster seats stay Anthropic; Nous Portal models dispatch through the AgentTool engine path')
}

export const nousProviderAdapter: ProviderAdapter = {
  id: 'nous',
  transport: 'openai-compat-chat-completions',
  status: nousStatus,
  describe: describeNousProvider,
  listModels: listNousModels,
  resolveModel: resolveNousModel,
  buildLaunchPatch: buildNousLaunchPatch,
}
