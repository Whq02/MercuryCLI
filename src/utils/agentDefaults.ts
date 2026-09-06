
import { EFFORT_LEVELS, type EffortLevel } from '../entrypoints/sdk/runtimeTypes.js'
import { getGlobalConfig, type GlobalConfig } from './config.js'

export const SUBAGENT_DEFAULT_EFFORT: EffortLevel = 'high'
export const SUBAGENT_DEFAULT_MAX_CONCURRENT = 8

export type SubagentDefaultsRecord = NonNullable<GlobalConfig['agents']>

export type SubagentDefaults = {
  effort: EffortLevel
  effortSource: 'setting' | 'convention'
  model: string | undefined
  maxConcurrent: number
  maxConcurrentSource: 'setting' | 'convention'
}

function isLadderWord(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function subagentDefaultsOf(record: SubagentDefaultsRecord | undefined): SubagentDefaults {
  const effort = isLadderWord(record?.defaultEffort) ? record.defaultEffort : undefined
  const model =
    typeof record?.defaultModel === 'string' && record.defaultModel.trim() !== ''
      ? record.defaultModel.trim()
      : undefined
  const cap = isPositiveInteger(record?.maxConcurrent) ? record.maxConcurrent : undefined
  return {
    effort: effort ?? SUBAGENT_DEFAULT_EFFORT,
    effortSource: effort !== undefined ? 'setting' : 'convention',
    model,
    maxConcurrent: cap ?? SUBAGENT_DEFAULT_MAX_CONCURRENT,
    maxConcurrentSource: cap !== undefined ? 'setting' : 'convention',
  }
}

export function subagentDefaults(): SubagentDefaults {
  return subagentDefaultsOf(getGlobalConfig().agents)
}

export function subagentDefaultEffort(): EffortLevel {
  return subagentDefaults().effort
}

export function subagentDefaultModel(): string | undefined {
  return subagentDefaults().model
}

export function subagentConcurrencyCap(
  envCap: number | null,
  record: SubagentDefaultsRecord | undefined = getGlobalConfig().agents,
): { cap: number; source: 'env' | 'setting' | 'convention' } {
  if (envCap !== null) return { cap: envCap, source: 'env' }
  const defaults = subagentDefaultsOf(record)
  return { cap: defaults.maxConcurrent, source: defaults.maxConcurrentSource }
}
