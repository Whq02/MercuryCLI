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
}

let facts: BootBirthFacts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null }

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

export function birthModelOf(record: Pick<BootBirthFacts, 'model'>, doorModel: string | null | undefined, screenModel: string): string {
  return record.model ?? doorModel ?? screenModel
}

export function carriedKitOf(record: Pick<BootBirthFacts, 'kit'>): { kit: SessionKitV1 } | Record<string, never> {
  return record.kit !== null ? { kit: record.kit } : {}
}

export function _resetBootBirthFactsForTesting(): void {
  facts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null }
}
