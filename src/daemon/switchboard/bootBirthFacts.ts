import type { PermissionMode } from '../../permissions/rules/permissions.js'
import type { SessionKitV1 } from '../session-seat/sessionKit.js'

interface LandingWords {
  model: string | null
  effort: string | null
  permissionMode: PermissionMode | null
}

export interface BootBirthFacts {
  title: string | null
  model: string | null
  effort: string | null
  permissionMode: PermissionMode | null
  permissionModeTyped: boolean
  runnerArgv: readonly string[]
  kit: SessionKitV1 | null
  presetKit: { name: string; kit: SessionKitV1 } | null
  bypassConsent: boolean
  landing: LandingWords | null
}

let facts: BootBirthFacts = { title: null, model: null, effort: null, permissionMode: null, permissionModeTyped: false, runnerArgv: [], kit: null, presetKit: null, bypassConsent: false, landing: null }

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

interface BirthFallbackInput {
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
    receipt: '/logins to add your provider oauth or api',
  }
}

export function screenBirthModel(): string | undefined {
  const { getEngineModel, getUserSpecifiedModelSetting } = require('../../models/catalogue/engineModel.js') as typeof import('../../models/catalogue/engineModel.js')
  const { getEngineModelOverride } = require('../../boot/process-state/processState.js') as typeof import('../../boot/process-state/processState.js')
  if (getEngineModelOverride() !== undefined) return getEngineModel()
  const { computedDefault } = require('../../models/catalogue/computedDefault.js') as typeof import('../../models/catalogue/computedDefault.js')
  const decision = computedDefault()
  if (decision.source !== 'keyless') return getEngineModel()
  if (getUserSpecifiedModelSetting() === null) return undefined
  const saved = getEngineModel()
  const { declaredRouteOf } = require('../../models/roads/routeLaw.js') as typeof import('../../models/roads/routeLaw.js')
  const family = declaredRouteOf(saved)
  if (family === 'local') return saved
  if (family === null || !decision.considered.some(credential => credential.family === family)) return undefined
  if (family !== 'openai-compat') return saved
  const { isCompatModelCredentialed } = require('../../models/roads/openaicompat/compatAccounts.js') as typeof import('../../models/roads/openaicompat/compatAccounts.js')
  return isCompatModelCredentialed(saved) ? saved : undefined
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

export function carriedTypedModeOf(record: Pick<BootBirthFacts, 'permissionMode' | 'permissionModeTyped'>, carried: string | null | undefined = record.permissionMode): { permissionModeTyped: true } | Record<string, never> {
  return record.permissionModeTyped && carried === record.permissionMode ? { permissionModeTyped: true } : {}
}

export function carriedRunnerArgvOf(record: Pick<BootBirthFacts, 'runnerArgv'>): { runnerArgv: string[] } | Record<string, never> {
  return record.runnerArgv.length > 0 ? { runnerArgv: [...record.runnerArgv] } : {}
}

export function resumeLaunchWordsOf(
  opts: { model?: string; effort?: string; restartReason?: 'update' } | undefined,
  record: Pick<BootBirthFacts, 'model' | 'effort'> = facts,
): { model?: string; effort?: string } {
  const carryBoot = opts?.restartReason === undefined
  const model = opts?.model ?? (carryBoot ? record.model ?? undefined : undefined)
  const effort = opts?.effort ?? (carryBoot ? record.effort ?? undefined : undefined)
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }
}

export function _resetBootBirthFactsForTesting(): void {
  facts = { title: null, model: null, effort: null, permissionMode: null, permissionModeTyped: false, runnerArgv: [], kit: null, presetKit: null, bypassConsent: false, landing: null }
}
