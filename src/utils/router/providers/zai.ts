import { getCachedProviderDiscovery, primeZaiDiscovery } from '../providerDiscovery.js'
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
const GLM_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const
const GLM_53_EFFORTS = ['low', 'high', 'max'] as const

export const GLM_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = [
  {
    id: 'glm-5.3',
    displayLabel: 'GLM-5.3',
    modelClass: 'glm',
    contextWindow: 1_000_000,
    efforts: GLM_53_EFFORTS,
    roles: ALL_ROLES,
  },
  {
    id: 'glm-5.2',
    displayLabel: 'GLM-5.2',
    modelClass: 'glm',
    contextWindow: 1_000_000,
    efforts: GLM_EFFORTS,
    roles: ALL_ROLES,
  },
]

export function describeZaiProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('zai')
  const keyPresent = discovery?.provider === 'zai' ? discovery.keyPresent : false
  return {
    transport: 'zai-chat-completions',
    capabilities: [
      'streaming',
      'tool-calls',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: ALL_ROLES,
    account: keyPresent
      ? {
          kind: 'api-key',
          label:
            discovery?.provider === 'zai' && discovery.keySource === 'stored'
              ? discovery.keyPlan === 'coding'
                ? 'GLM Coding Plan key (stored, auth-scoped)'
                : 'Z.AI API key (stored, auth-scoped)'
              : 'ZAI_API_KEY (env)',
        }
      : { kind: 'none', label: 'no Z.AI API key detected' },
    catalogue: GLM_STATIC_CATALOGUE,
    catalogueSource: 'static-pin',
  }
}

export function zaiStatus(): RouterProviderStatus {
  const discovery = primeZaiDiscovery()
  return discovery?.keyPresent
    ? { available: true }
    : { available: false, reason: 'no-api-key:zai' }
}

export function listZaiModels(): RouterProviderModel[] {
  if (!zaiStatus().available) return []
  return GLM_STATIC_CATALOGUE.map(entry => ({
    ref: {
      provider: 'zai' as const,
      model: entry.id,
      modelClass: 'glm' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveZaiModel(
  _modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  return null
}

export function buildZaiLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider zai has no SEAT runtime — party/roster seats stay Anthropic; GLM specialists dispatch through the AgentTool engine path',
  )
}

export const zaiProviderAdapter: RouterProviderAdapter = {
  id: 'zai',
  transport: 'zai-chat-completions',
  status: zaiStatus,
  describe: describeZaiProvider,
  listModels: listZaiModels,
  resolveModel: resolveZaiModel,
  buildLaunchPatch: buildZaiLaunchPatch,
}
