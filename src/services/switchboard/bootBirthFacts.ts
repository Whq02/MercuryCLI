import type { PermissionMode } from '../../types/permissions.js'
import type { SessionKitV1 } from '../../daemon/sessionKit.js'

export interface BootBirthFacts {
  title: string | null
  model: string | null
  effort: string | null
  permissionMode: PermissionMode | null
  runnerArgv: readonly string[]
  kit: SessionKitV1 | null
  presetKit: { name: string; kit: SessionKitV1 } | null
  bypassConsent: boolean
}

let facts: BootBirthFacts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null, bypassConsent: false }

export function setBootBirthFacts(next: Partial<BootBirthFacts>): void {
  facts = { ...facts, ...next, runnerArgv: [...(next.runnerArgv ?? facts.runnerArgv)] }
}

export const setNextSessionFacts = setBootBirthFacts

export function bootBirthFacts(): BootBirthFacts {
  return facts
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

export function screenBirthModel(): string | undefined {
  const { computedDefault } = require('../../utils/model/computedDefault.js') as typeof import('../../utils/model/computedDefault.js')
  if (computedDefault().source === 'keyless') return undefined
  const { getMainLoopModel } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
  return getMainLoopModel()
}

export function carriedKitOf(record: Pick<BootBirthFacts, 'kit'>): { kit: SessionKitV1 } | Record<string, never> {
  return record.kit !== null ? { kit: record.kit } : {}
}

export function carriedConsentOf(record: Pick<BootBirthFacts, 'bypassConsent'>): { bypassConsent: true } | Record<string, never> {
  return record.bypassConsent ? { bypassConsent: true } : {}
}

export function _resetBootBirthFactsForTesting(): void {
  facts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null, bypassConsent: false }
}
