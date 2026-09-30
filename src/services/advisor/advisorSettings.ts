import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'
import {
  resolveSubModel,
  subModelDispatchEffort,
  subModelEnvVar,
  type SubModelResolution,
} from '../../utils/model/subModelSlots.js'
import type { EffortLevel } from '../../utils/effort.js'
import { isCrewmate } from '../../utils/crewmate.js'
import { advisorMinutesWords } from '../../utils/messages/noticeRows.js'
import { advisorSwitchOfSession } from '../../utils/sessionStorage/writer.js'
import { isCrewRole } from '../../utils/workerRole.js'

export type AdvisorSeat = 'main' | 'crewmate' | 'workflow'

export interface AdvisorSettings {
  enabled: boolean
  minutes: number
}

export const ADVISOR_DEFAULT_MINUTES = 10
export const ADVISOR_MINUTES_FLOOR = 1
export const ADVISOR_MINUTES_LADDER: readonly number[] = Object.freeze([10, 20, 30, 45, 60])
export const ADVISOR_CONTAINER = 'advisor' as const
export const ADVISOR_ENV_VAR = subModelEnvVar(ADVISOR_CONTAINER)

export const ADVISOR_DEFAULT_SETTINGS: Readonly<AdvisorSettings> = Object.freeze({
  enabled: false,
  minutes: ADVISOR_DEFAULT_MINUTES,
})

export const ADVISOR_WORKFLOW_REFUSAL = 'the advisor is not available to workflow agents'
export const ADVISOR_CREWMATE_REFUSAL = 'the advisor is not available to crewmates'
export const ADVISOR_SETTINGS_OFF_REFUSAL = 'the advisor is off in the settings — /config → Advisor turns it on'
export const ADVISOR_CHAT_OFF_REFUSAL = 'the advisor is off for this chat — /advise on turns it on'
export const ADVISOR_COMMAND = '/advise'
export const ADVISOR_SETTINGS_OFF_NOTE = '/config → Advisor must be on for any chat to get notes'

type StoredAdvisor = NonNullable<ReturnType<typeof getGlobalConfig>['advisor']>

function minutesOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= ADVISOR_MINUTES_FLOOR ? value : undefined
}

export function advisorSettingsFromStored(stored: StoredAdvisor | undefined): AdvisorSettings {
  return {
    enabled: stored?.enabled === true,
    minutes: minutesOf(stored?.minutes) ?? ADVISOR_DEFAULT_MINUTES,
  }
}

export function readAdvisorSettings(): AdvisorSettings {
  if (!isConfigReadingAllowed()) return { ...ADVISOR_DEFAULT_SETTINGS }
  return advisorSettingsFromStored(getGlobalConfig().advisor)
}

export function advisorSessionSeat(): AdvisorSeat {
  return isCrewRole() || isCrewmate() ? 'crewmate' : 'main'
}

export function advisorChatSwitch(): boolean {
  return advisorSwitchOfSession()
}

export function advisorEnabled(): boolean {
  return advisorSeatRefusal(advisorSessionSeat()) === undefined
}

export function advisorSeatRefusal(
  seat: AdvisorSeat,
  settings: AdvisorSettings = readAdvisorSettings(),
  chat: boolean = advisorChatSwitch(),
): string | undefined {
  if (seat === 'workflow') return ADVISOR_WORKFLOW_REFUSAL
  if (seat === 'crewmate') return ADVISOR_CREWMATE_REFUSAL
  if (!settings.enabled) return ADVISOR_SETTINGS_OFF_REFUSAL
  if (!chat) return ADVISOR_CHAT_OFF_REFUSAL
  return undefined
}

export interface AdvisorFacts {
  on: boolean
  chat: boolean
  settings: boolean
  minutes: number
  model: string | null
}

export function advisorFacts(): AdvisorFacts {
  const settings = readAdvisorSettings()
  const model = resolveAdvisorModel()
  return {
    on: advisorSeatRefusal(advisorSessionSeat(), settings) === undefined,
    chat: advisorChatSwitch(),
    settings: settings.enabled,
    minutes: settings.minutes,
    model: model.origin === 'unset' ? null : model.model,
  }
}

export function advisorChipWords(facts: AdvisorFacts | null): string | null {
  if (facts === null || !facts.chat) return null
  if (!facts.settings) return 'advisor · off in settings'
  if (!facts.on) return null
  return `advisor · ${advisorIntervalWords(facts.minutes)}`
}

export interface AdvisorChatState {
  chat: boolean
  settings: AdvisorSettings
  model: SubModelResolution
}

export function advisorChatState(): AdvisorChatState {
  return { chat: advisorChatSwitch(), settings: readAdvisorSettings(), model: resolveAdvisorModel() }
}

export function advisorChatLine(state: AdvisorChatState = advisorChatState()): string {
  const modelWords = state.model.origin === 'unset' ? 'no advisor model pinned — /submodels sets one' : state.model.model
  const parts = [
    state.chat ? 'advisor on for this chat' : `advisor off for this chat — ${ADVISOR_COMMAND} on turns it on`,
    modelWords,
    advisorIntervalWords(state.settings.minutes),
  ]
  if (!state.settings.enabled) parts.push(`off in the settings — ${ADVISOR_SETTINGS_OFF_NOTE}`)
  return parts.join(' · ')
}

function writeAdvisor(mutate: (stored: StoredAdvisor) => StoredAdvisor): AdvisorSettings {
  let out: AdvisorSettings = { ...ADVISOR_DEFAULT_SETTINGS }
  saveGlobalConfig(config => {
    const next = mutate({ ...(config.advisor ?? {}) })
    const trimmed: StoredAdvisor = {}
    if (next.enabled === true) trimmed.enabled = true
    if (minutesOf(next.minutes) !== undefined && next.minutes !== ADVISOR_DEFAULT_MINUTES) trimmed.minutes = next.minutes
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

export function setAdvisorMinutes(next: number): AdvisorSettings {
  const value = minutesOf(next)
  if (value === undefined) {
    throw new Error(`the advisor interval is a whole number of minutes (${ADVISOR_MINUTES_FLOOR} or more), not ${String(next)}`)
  }
  return writeAdvisor(stored => ({ ...stored, minutes: value }))
}

export function resolveAdvisorModel(): SubModelResolution {
  return resolveSubModel(ADVISOR_CONTAINER)
}

export function advisorDispatchEffort(model: string): EffortLevel | undefined {
  return subModelDispatchEffort(ADVISOR_CONTAINER, model).effortValue
}

export function advisorIntervalWords(minutes: number): string {
  return advisorMinutesWords(minutes)
}

export const ADVISOR_PER_CHAT_WORDS = `${ADVISOR_COMMAND} turns it on per chat`

export function advisorValueWords(settings: AdvisorSettings = readAdvisorSettings()): string {
  return settings.enabled ? `on · ${advisorIntervalWords(settings.minutes)} · ${ADVISOR_PER_CHAT_WORDS}` : 'off'
}

export function advisorReceiptWords(settings: AdvisorSettings): string {
  const model = resolveAdvisorModel()
  const modelWords = model.origin === 'unset' ? 'no advisor model pinned — /submodels sets one' : `advisor model ${model.model}`
  return settings.enabled
    ? `Advisor on — a note ${advisorIntervalWords(settings.minutes)}; ${modelWords}`
    : `Advisor off — no note is written and nothing is sent; ${modelWords}`
}

export const ADVISOR_DOORS = '/config (the Advisor rows, the settings for every chat), /advise (this chat) and /submodels (the ADVISOR container)'
