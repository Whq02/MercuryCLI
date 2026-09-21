import type { PermissionMode } from '../../types/permissions.js'
import type { SessionKitV1 } from '../../daemon/sessionKit.js'

export interface LandingWords {
  model: string | null
  effort: string | null
  permissionMode: PermissionMode | null
}

export interface BootBirthFacts {
  title: string | null
  model: string | null
  effort: string | null
  permissionMode: PermissionMode | null
  runnerArgv: readonly string[]
  kit: SessionKitV1 | null
  presetKit: { name: string; kit: SessionKitV1 } | null
  bypassConsent: boolean
  landing: LandingWords | null
}

let facts: BootBirthFacts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null, bypassConsent: false, landing: null }

export function setBootBirthFacts(next: Partial<BootBirthFacts>): void {
  facts = { ...facts, ...next, runnerArgv: [...(next.runnerArgv ?? facts.runnerArgv)] }
}

export const setNextSessionFacts = setBootBirthFacts

export function bootBirthFacts(): BootBirthFacts {
  return facts
}

export function armLandingWords(words: LandingWords): void {
  facts = { ...facts, landing: { model: words.model, effort: words.effort, permissionMode: words.permissionMode } }
}

export function settleLandingWords(): void {
  if (facts.landing !== null) facts = { ...facts, landing: null }
}

export function landingWordsOf(record: Pick<BootBirthFacts, 'landing'>): LandingWords {
  const landing = record.landing
  if (landing === null) return { model: null, effort: null, permissionMode: null }
  return { model: landing.model, effort: landing.effort, permissionMode: landing.permissionMode }
}

export function takeBootTitle(): string | null {
  const title = facts.title
  facts = { ...facts, title: null }
  return title
}

export function peekWornPresetKit(): { name: string; kit: SessionKitV1 } | null {
  return facts.presetKit
}

export function takeWornPresetKit(): { name: string; kit: SessionKitV1 } | null {
  const worn = facts.presetKit
  facts = { ...facts, presetKit: null }
  return worn
}

export function birthModelOf(record: Pick<BootBirthFacts, 'model'>, doorModel: string | null | undefined, screenModel: string | undefined): string | undefined {
  return record.model ?? doorModel ?? screenModel
}

export interface BirthFallbackInput {
  family: string | null
  familyWord: string
  hasCredential: boolean
  refusal: string | null
  fallback: { setting: string; family: string; row: string } | null
  providerName: (family: string) => string
}

export function birthFallbackModel(resolved: string, input: BirthFallbackInput): { setting: string; receipt: string } | undefined {
  if (input.fallback === null) return undefined
  if (input.family !== null && input.family === input.fallback.family) return undefined
  if (input.hasCredential && (input.refusal === null || input.refusal.trim() === '')) return undefined
  const word = input.familyWord
  const row = input.fallback.row
  const provider = input.providerName(input.fallback.family)
  if (input.hasCredential && input.refusal !== null) {
    return {
      setting: input.fallback.setting,
      receipt: `▲ the saved default ${word} has no usable row: ${input.refusal}. This chat runs on ${row} (${provider}, the most recent sign-in); /model changes the default`,
    }
  }
  return {
    setting: input.fallback.setting,
    receipt: `▲ the saved default ${word} has no sign-in here — this chat runs on ${row} (${provider}, the most recent sign-in); /logins ${word} connects it, /model changes the default`,
  }
}

export function screenBirthModel(): string | undefined {
  const { getMainLoopModel } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
  const { getMainLoopModelOverride } = require('../../bootstrap/state.js') as typeof import('../../bootstrap/state.js')
  if (getMainLoopModelOverride() !== undefined) return getMainLoopModel()
  const { computedDefault } = require('../../utils/model/computedDefault.js') as typeof import('../../utils/model/computedDefault.js')
  if (computedDefault().source === 'keyless') return undefined
  return getMainLoopModel()
}

export function nextBirthModel(): string | undefined {
  const screen = screenBirthModel()
  return screen === undefined ? undefined : birthModelOf(bootBirthFacts(), null, screen)
}

export function carriedKitOf(record: Pick<BootBirthFacts, 'kit'>): { kit: SessionKitV1 } | Record<string, never> {
  return record.kit !== null ? { kit: record.kit } : {}
}

export function carriedConsentOf(record: Pick<BootBirthFacts, 'bypassConsent'>): { bypassConsent: true } | Record<string, never> {
  return record.bypassConsent ? { bypassConsent: true } : {}
}

export function _resetBootBirthFactsForTesting(): void {
  facts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null, bypassConsent: false, landing: null }
}
