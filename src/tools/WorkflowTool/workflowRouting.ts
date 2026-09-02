import { flagEnv } from '../../substrate/flagRegistry.js'

export const WORKFLOW_TIERS = ['orchestrator', 'executor'] as const
export type WorkflowTier = (typeof WORKFLOW_TIERS)[number]

export function workflowExecutorModel(): string | undefined {
  const { neutralSeatDefault } =
    require('../../services/concourse/workerModels.js') as typeof import('../../services/concourse/workerModels.js')
  return neutralSeatDefault()?.setting
}

export function workflowRoutingEnabled(): boolean {
  return flagEnv('MERCURY_WORKFLOW_ROUTING') === '1'
}

export function validateWorkflowTier(tier: unknown): void {
  if (tier === undefined) return
  if (typeof tier !== 'string' || !(WORKFLOW_TIERS as readonly string[]).includes(tier)) {
    throw new TypeError(
      `agent({tier}) must be one of ${WORKFLOW_TIERS.join(' | ')}; got ${JSON.stringify(tier)}`,
    )
  }
}

export function resolveWorkflowRoutedModel(opts: {
  tier?: unknown
  model?: unknown
}): string | undefined {
  if (!workflowRoutingEnabled()) return undefined
  if (opts.tier !== 'executor') return undefined
  if (opts.model !== undefined && opts.model !== null) return undefined
  return workflowExecutorModel()
}
