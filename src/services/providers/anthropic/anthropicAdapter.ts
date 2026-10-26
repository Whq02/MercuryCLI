import { getContextWindowForModel } from '../../../utils/context.js'
import { modelSupportsMaxEffort, modelSupportsXHighEffort } from '../../../utils/model/capabilities.js'
import { getDefaultFableModel, getDefaultOpusModel, getDefaultSonnetModel, renderModelChip } from '../../../utils/model/model.js'
import type {
  ProviderDescription,
  ProviderEffortLevel,
  ProviderModelRef,
  ProviderModelClass,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
} from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

type AnthropicModelClass = 'opus' | 'sonnet' | 'fable'

function isAnthropicModelClass(modelClass: ProviderModelClass): modelClass is AnthropicModelClass {
  return modelClass === 'opus' || modelClass === 'sonnet' || modelClass === 'fable'
}

function classDefaultModel(modelClass: AnthropicModelClass): string {
  if (modelClass === 'opus') return getDefaultOpusModel()
  if (modelClass === 'sonnet') return getDefaultSonnetModel()
  const fable = getDefaultFableModel()
  return getContextWindowForModel(fable) >= 1_000_000 ? fable : `${fable}[1m]`
}

const ROUTE_EFFORT_LADDER: readonly ProviderEffortLevel[] = ['high', 'xhigh', 'max']

export function routeEffortsFor(model: string): ProviderEffortLevel[] {
  return ROUTE_EFFORT_LADDER.filter(level =>
    level === 'high' ? true : level === 'xhigh' ? modelSupportsXHighEffort(model) : modelSupportsMaxEffort(model),
  )
}

function defaultEffortFor(modelClass: AnthropicModelClass): ProviderEffortLevel {
  return modelClass === 'opus' ? 'xhigh' : 'high'
}

function anthropicStatus(): ProviderStatus {
  return { available: true }
}

export function resolveAnthropicModel(
  modelClass: ProviderModelClass,
): ProviderModelRef | null {
  if (!isAnthropicModelClass(modelClass)) return null
  const model = classDefaultModel(modelClass)
  const effort = defaultEffortFor(modelClass)
  const contextWindow = getContextWindowForModel(model)
  return { provider: 'anthropic', model, modelClass, effort, contextWindow }
}

export function listAnthropicModels(): ProviderModel[] {
  const classes: AnthropicModelClass[] = ['opus', 'sonnet', 'fable']
  const out: ProviderModel[] = []
  for (const modelClass of classes) {
    const ref = resolveAnthropicModel(modelClass)
    if (ref) out.push({ ref, displayLabel: renderModelChip(ref.model) })
  }
  return out
}

function buildAnthropicLaunchPatch(ref: ProviderModelRef): { model: string; effort: string } {
  return { model: ref.model, effort: ref.effort }
}

function describeAnthropicProvider(): ProviderDescription {
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

export const anthropicProviderAdapter: ProviderAdapter = {
  id: 'anthropic',
  transport: 'anthropic-messages',
  status: anthropicStatus,
  describe: describeAnthropicProvider,
  listModels: listAnthropicModels,
  resolveModel: resolveAnthropicModel,
  buildLaunchPatch: buildAnthropicLaunchPatch,
}
