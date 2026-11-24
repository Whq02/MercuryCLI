
import { EFFORT_LEVELS, type EffortLevel } from '../../models/effort/effortLadder.js'
import { getGlobalConfig, type GlobalConfig } from '../../platform/settings/config.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'

export const CREWMATE_DEFAULT_EFFORT: EffortLevel = 'high'
export const CREWMATE_DEFAULT_MAX_CONCURRENT = 8

type CrewmateDefaultsRecord = NonNullable<GlobalConfig['agents']>

type CrewmateDefaults = {
  effort: EffortLevel
  effortSource: 'setting' | 'convention'
  model: string | undefined
  maxConcurrent: number
  maxConcurrentSource: 'setting' | 'convention'
}

function isLadderWord(value: unknown): value is EffortLevel {
  return typeof value === 'string' && isOneOf(EFFORT_LEVELS, value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function crewmateDefaultsOf(record: CrewmateDefaultsRecord | undefined): CrewmateDefaults {
  const effort = isLadderWord(record?.defaultEffort) ? record.defaultEffort : undefined
  const model =
    typeof record?.defaultModel === 'string' && record.defaultModel.trim() !== '' && record.defaultModel.trim().toLowerCase() !== 'inherit'
      ? record.defaultModel.trim()
      : undefined
  const cap = isPositiveInteger(record?.maxConcurrent) ? record.maxConcurrent : undefined
  return {
    effort: effort ?? CREWMATE_DEFAULT_EFFORT,
    effortSource: effort !== undefined ? 'setting' : 'convention',
    model,
    maxConcurrent: cap ?? CREWMATE_DEFAULT_MAX_CONCURRENT,
    maxConcurrentSource: cap !== undefined ? 'setting' : 'convention',
  }
}

export function crewmateDefaults(): CrewmateDefaults {
  return crewmateDefaultsOf(getGlobalConfig().agents)
}

export function defaultCrewmateEffort(): EffortLevel {
  return crewmateDefaults().effort
}

export function defaultCrewmateModel(): string | undefined {
  return crewmateDefaults().model
}

export function crewmateConcurrencyCap(
  envCap: number | null,
  record: CrewmateDefaultsRecord | undefined = getGlobalConfig().agents,
): { cap: number; source: 'env' | 'setting' | 'convention' } {
  if (envCap !== null) return { cap: envCap, source: 'env' }
  const defaults = crewmateDefaultsOf(record)
  return { cap: defaults.maxConcurrent, source: defaults.maxConcurrentSource }
}
