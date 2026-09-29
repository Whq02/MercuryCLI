import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'
import {
  resolveSubModel,
  subModelDispatchEffort,
  subModelEnvVar,
  type SubModelResolution,
} from '../../utils/model/subModelSlots.js'
import type { EffortLevel } from '../../utils/effort.js'
import { isCrewmate } from '../../utils/crewmate.js'
import { isCrewRole } from '../../utils/workerRole.js'

export type AdvisorSeat = 'main' | 'crewmate' | 'workflow'

export interface AdvisorSettings {
  enabled: boolean
  crewmates: boolean
  seats: number
}

export const ADVISOR_DEFAULT_SEATS = 10
export const ADVISOR_SEATS_FLOOR = 1
export const ADVISOR_SEATS_LADDER: readonly number[] = Object.freeze([5, 10, 20, 50])
export const ADVISOR_CONTAINER = 'advisor' as const
export const ADVISOR_ENV_VAR = subModelEnvVar(ADVISOR_CONTAINER)

export const ADVISOR_DEFAULT_SETTINGS: Readonly<AdvisorSettings> = Object.freeze({
  enabled: false,
  crewmates: false,
  seats: ADVISOR_DEFAULT_SEATS,
})

type StoredAdvisor = NonNullable<ReturnType<typeof getGlobalConfig>['advisor']>

function seatsOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= ADVISOR_SEATS_FLOOR ? value : undefined
}

export function advisorSettingsFromStored(stored: StoredAdvisor | undefined): AdvisorSettings {
  return {
    enabled: stored?.enabled === true,
    crewmates: stored?.crewmates === true,
    seats: seatsOf(stored?.seats) ?? ADVISOR_DEFAULT_SEATS,
  }
}

export function readAdvisorSettings(): AdvisorSettings {
  if (!isConfigReadingAllowed()) return { ...ADVISOR_DEFAULT_SETTINGS }
  return advisorSettingsFromStored(getGlobalConfig().advisor)
}

export function advisorSessionSeat(): AdvisorSeat {
  return isCrewRole() || isCrewmate() ? 'crewmate' : 'main'
}

export function advisorEnabled(): boolean {
  return advisorSeatRefusal(advisorSessionSeat()) === undefined
}

export function advisorSeatRefusal(seat: AdvisorSeat, settings: AdvisorSettings = readAdvisorSettings()): string | undefined {
  if (seat === 'workflow') return 'the advisor is not available to workflow agents'
  if (!settings.enabled) return 'the advisor is off — /config turns it on'
  if (seat === 'crewmate' && !settings.crewmates) return 'the advisor is off for crewmates — /config → Advisor for crewmates turns it on separately'
  return undefined
}

function writeAdvisor(mutate: (stored: StoredAdvisor) => StoredAdvisor): AdvisorSettings {
  let out: AdvisorSettings = { ...ADVISOR_DEFAULT_SETTINGS }
  saveGlobalConfig(config => {
    const next = mutate({ ...(config.advisor ?? {}) })
    const trimmed: StoredAdvisor = {}
    if (next.enabled === true) trimmed.enabled = true
    if (next.crewmates === true) trimmed.crewmates = true
    if (seatsOf(next.seats) !== undefined && next.seats !== ADVISOR_DEFAULT_SEATS) trimmed.seats = next.seats
    out = advisorSettingsFromStored(trimmed)
    const rest = { ...config }
    if (Object.keys(trimmed).length === 0) delete rest.advisor
    else rest.advisor = trimmed
    return rest
  })
  return out
}

export function setAdvisorEnabled(next: boolean): AdvisorSettings {
  return writeAdvisor(stored => ({ ...stored, enabled: next }))
}

export function setAdvisorCrewmates(next: boolean): AdvisorSettings {
  return writeAdvisor(stored => ({ ...stored, crewmates: next }))
}

export function setAdvisorSeats(next: number): AdvisorSettings {
  const value = seatsOf(next)
  if (value === undefined) {
    throw new Error(`the advisor interval is a whole number of turns (${ADVISOR_SEATS_FLOOR} or more), not ${String(next)}`)
  }
  return writeAdvisor(stored => ({ ...stored, seats: value }))
}

export function resolveAdvisorModel(): SubModelResolution {
  return resolveSubModel(ADVISOR_CONTAINER)
}

export function advisorDispatchEffort(model: string): EffortLevel | undefined {
  return subModelDispatchEffort(ADVISOR_CONTAINER, model).effortValue
}

export function advisorValueWords(settings: AdvisorSettings = readAdvisorSettings()): string {
  return settings.enabled ? `on · every ${settings.seats} turns` : 'off'
}

export function advisorIntervalWords(seats: number): string {
  return `every ${seats} turn${seats === 1 ? '' : 's'}`
}

export function advisorReceiptWords(settings: AdvisorSettings): string {
  const model = resolveAdvisorModel()
  const modelWords = model.origin === 'unset' ? 'no advisor model pinned — /submodels sets one' : `advisor model ${model.model}`
  return settings.enabled
    ? `Advisor on — a note ${advisorIntervalWords(settings.seats)}; ${modelWords}`
    : `Advisor off — no note is written and nothing is sent; ${modelWords}`
}

export const ADVISOR_DOORS = '/config (the Advisor rows) and /submodels (the ADVISOR container)'
