
export type WorkflowUsageRollup = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  apiTurns: number
  unsettledTurns: number
}

export type WorkflowRunUsage = WorkflowUsageRollup & {
  agentsReporting: number
  agentsUnreported: number
}

export const EMPTY_WORKFLOW_USAGE: Readonly<WorkflowUsageRollup> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  apiTurns: 0,
  unsettledTurns: 0,
})

export function workflowUsageSpend(u: WorkflowUsageRollup): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens
}

export function addWorkflowUsage(a: WorkflowUsageRollup, b: WorkflowUsageRollup): WorkflowUsageRollup {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    apiTurns: a.apiTurns + b.apiTurns,
    unsettledTurns: a.unsettledTurns + b.unsettledTurns,
  }
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'apiTurns', 'unsettledTurns'] as const

export function readWorkflowUsage(v: unknown): WorkflowUsageRollup | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const out: Partial<Record<(typeof USAGE_KEYS)[number], number>> = {}
  for (const k of USAGE_KEYS) {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined
    out[k] = n
  }
  return out as WorkflowUsageRollup
}

export function rollupWorkflowUsage(agents: ReadonlyArray<{ usage?: unknown }>): WorkflowRunUsage | undefined {
  let sum: WorkflowUsageRollup = EMPTY_WORKFLOW_USAGE
  let agentsReporting = 0
  let agentsUnreported = 0
  for (const a of agents) {
    const u = readWorkflowUsage(a.usage)
    if (u === undefined) {
      agentsUnreported++
      continue
    }
    agentsReporting++
    sum = addWorkflowUsage(sum, u)
  }
  if (agentsReporting === 0) return undefined
  return { ...sum, agentsReporting, agentsUnreported }
}

export function foldResponseUsage(
  into: WorkflowUsageRollup,
  response: {
    stop_reason?: string | null
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number | null
      cache_creation_input_tokens?: number | null
    } | null
  },
): WorkflowUsageRollup {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const u = response.usage
  if (u == null || response.stop_reason == null) {
    return { ...into, unsettledTurns: into.unsettledTurns + 1 }
  }
  return {
    inputTokens: into.inputTokens + n(u.input_tokens),
    outputTokens: into.outputTokens + n(u.output_tokens),
    cacheReadTokens: into.cacheReadTokens + n(u.cache_read_input_tokens),
    cacheCreationTokens: into.cacheCreationTokens + n(u.cache_creation_input_tokens),
    apiTurns: into.apiTurns + 1,
    unsettledTurns: into.unsettledTurns,
  }
}

export function usageSpeaks(u: WorkflowUsageRollup): boolean {
  return u.apiTurns > 0 || u.unsettledTurns > 0
}

export function workflowSpendWords(u: WorkflowUsageRollup, formatTokens: (n: number) => string): string {
  const spend = `${formatTokens(workflowUsageSpend(u))} spent`
  if (u.unsettledTurns === 0) return spend
  return `${spend} · ${u.unsettledTurns} ${u.unsettledTurns === 1 ? 'turn' : 'turns'} unmeasured`
}
