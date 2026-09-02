// ============================================================================
//  providers/zai.ts — the Z.ai (GLM) RouterProviderAdapter.
//
//  The runtime landed: src/services/providers/zai/ (native SSE client +
//  Anthropic-shape bridge, S4) + the provider-aware callModel branch
//  (zaiCallModel behind QueryDeps.callModel, S5). This adapter reports the
//  ENGINE truth (the native engine path is always on — availability is
//  credential truth alone):
//    - status() = the honest key state (`available:true` with ZAI_API_KEY
//      present, else the stable code 'no-api-key:zai'); the zai probe is
//      env-only, so status self-primes the discovery cache (no pending
//      state).
//    - SEATS STAY ANTHROPIC: resolveModel('glm', …) stays null and
//      buildLaunchPatch keeps throwing — there is NO GLM seat runtime; the
//      route fabric must never assign a GLM ref to a roster seat. GLM
//      specialists dispatch through the AgentTool/callModel engine path
//      (utils/swarm/engineDispatch.ts resolves against describe().catalogue).
//  Own context-window truth rides the catalogue (glm-5.2 1M documented) —
//  never Anthropic's tables. The key value never enters this surface.
// ============================================================================
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

// ──: the typed description surface (catalogue research,
//    recorded provider research). One static pin:
//    glm-5.2 — the current Z.AI text flagship (released; 1M-token
//    context + 128K max output VERIFIED on its guide page; the only GLM with
//    `reasoning_effort`), and the RECORDED resolution of the operator's
//    "GLM 5.5-2" preference (no glm-5.5* exists in the live catalogue — the
//    mapping is a recorded decision, never silent).
//    Further family members (glm-5.1/glm-5/glm-4.7…) join only with verified
//    context windows.
const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES
/** The documented glm-5.2 reasoning_effort vocabulary (chat-completion page). */
const GLM_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const
/** The documented glm-5.3 vocabulary (docs.z.ai glm-5.3 page, fetched
 * low|high|max only; reasoning cannot be disabled. */
const GLM_53_EFFORTS = ['low', 'high', 'max'] as const

export const GLM_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = [
  // glm-5.3 — the current Z.AI flagship (released; 1M context +
  // 128K max output VERIFIED on its docs.z.ai page, fetched).
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
  // The honest key state, self-primed (env-only).
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
  // SEATS STAY ANTHROPIC: route-fabric class
  // resolution feeds roster-seat retargeting, and no GLM seat runtime
  // exists — a GLM ref here would dispatch a seat that cannot run. The
  // specialist engine path resolves via describe().catalogue instead.
  return null
}

export function buildZaiLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider zai has no SEAT runtime — roster seats stay Anthropic; GLM specialists dispatch through the AgentTool engine path',
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
