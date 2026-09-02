import { getContextWindowForModel } from '../../context.js'
import { modelSupportsMaxEffort, modelSupportsXHighEffort } from '../../model/capabilities.js'
import { getCanonicalName, renderModelChip } from '../../model/model.js'
import { SEAT_ALLOWED_FAMILIES, validateSeatModel } from '../../model/seatSlots.js'
import type {
  ProviderDescription,
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
} from './types.js'
import { SPECIALIST_ROLES } from './types.js'

type AnthropicModelClass = 'opus' | 'sonnet' | 'fable'

function isAnthropicModelClass(modelClass: RouterModelClass): modelClass is AnthropicModelClass {
  return modelClass === 'opus' || modelClass === 'sonnet' || modelClass === 'fable'
}

const CLASS_DEFAULT_MODEL: Readonly<Record<AnthropicModelClass, string>> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5[1m]',
}

function classForCanonical(canonical: string): AnthropicModelClass | null {
  if (canonical === 'claude-opus-4-6') return 'opus'
  if (canonical === 'claude-opus-5') return 'opus'
  if (canonical === 'claude-sonnet-5') return 'sonnet'
  if (canonical === 'claude-fable-5') return 'fable'
  if (canonical === 'claude-fable-5-1') return 'fable'
  return null
}

const ROUTE_EFFORT_LADDER: readonly RouteEffortLevel[] = ['high', 'xhigh', 'max']

export function routeEffortsFor(model: string): RouteEffortLevel[] {
  return ROUTE_EFFORT_LADDER.filter(level =>
    level === 'high' ? true : level === 'xhigh' ? modelSupportsXHighEffort(model) : modelSupportsMaxEffort(model),
  )
}

function defaultEffortFor(modelClass: AnthropicModelClass, posture: RouterPosture): RouteEffortLevel {
  if (posture === 'quality') return modelClass === 'opus' ? 'max' : 'xhigh'
  return modelClass === 'opus' ? 'xhigh' : 'high'
}

export function anthropicStatus(): RouterProviderStatus {
  return { available: true }
}

export function resolveAnthropicModel(
  modelClass: RouterModelClass,
  posture: RouterPosture,
): RouteModelRef | null {
  if (!isAnthropicModelClass(modelClass)) return null
  const fallback = CLASS_DEFAULT_MODEL[modelClass]
  const validated = validateSeatModel(fallback, fallback)
  if (validated.note) return null
  const model = validated.model
  const canonical = getCanonicalName(model)
  if (!SEAT_ALLOWED_FAMILIES.includes(canonical)) return null
  const effort = defaultEffortFor(modelClass, posture)
  const contextWindow = getContextWindowForModel(model)
  return { provider: 'anthropic', model, modelClass, effort, contextWindow }
}

export function listAnthropicModels(): RouterProviderModel[] {
  const classes: AnthropicModelClass[] = ['opus', 'sonnet', 'fable']
  const out: RouterProviderModel[] = []
  for (const modelClass of classes) {
    const ref = resolveAnthropicModel(modelClass, 'adaptive')
    if (ref) out.push({ ref, displayLabel: renderModelChip(ref.model) })
  }
  return out
}

export function buildAnthropicLaunchPatch(ref: RouteModelRef): { model: string; effort: string } {
  return { model: ref.model, effort: ref.effort }
}

export function describeAnthropicProvider(): ProviderDescription {
  return {
    transport: 'anthropic-messages',
    capabilities: [
      'streaming',
      'tool-calls',
      'structured-output',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: SPECIALIST_ROLES,
    account: { kind: 'inherited-main', label: 'main-loop credentials' },
    catalogue: listAnthropicModels().map(m => ({
      id: m.ref.model,
      displayLabel: m.displayLabel,
      modelClass: m.ref.modelClass,
      contextWindow: m.ref.contextWindow,
      efforts: routeEffortsFor(m.ref.model),
      roles: SPECIALIST_ROLES,
    })),
    catalogueSource: 'static-pin',
  }
}

export const anthropicProviderAdapter: RouterProviderAdapter = {
  id: 'anthropic',
  transport: 'anthropic-messages',
  status: anthropicStatus,
  describe: describeAnthropicProvider,
  listModels: listAnthropicModels,
  resolveModel: resolveAnthropicModel,
  buildLaunchPatch: buildAnthropicLaunchPatch,
}
