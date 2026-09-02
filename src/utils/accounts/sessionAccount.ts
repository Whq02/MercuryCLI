import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import {
  anthropicCredentialPresence,
  presenceIdentityWords,
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../../services/providers/providerUsage.js'
import { computedDefault, type ComputedDefault } from '../model/computedDefault.js'
import { getUserSpecifiedModelSetting } from '../model/model.js'

export type SessionAccountWords =
  | { state: 'email'; text: string; family: string }
  | { state: 'none' }

type PresenceWords = Pick<ProviderFamilyPresence, 'credentialed' | 'credentialLabel' | 'identity'>

export interface SessionAccountReads {
  modelSetting?: () => string | null
  decision?: () => Pick<ComputedDefault, 'source' | 'provider' | 'considered'>
  presences?: () => readonly (PresenceWords & { id: string })[]
  anthropic?: () => PresenceWords
}

export function sessionAccountFamily(mainModel: string, reads: SessionAccountReads = {}): string | null {
  const route = declaredRouteOf(mainModel)
  const setting = (reads.modelSetting ?? getUserSpecifiedModelSetting)()
  if (setting !== null) return route
  const decision = (reads.decision ?? computedDefault)()
  if (decision.provider !== null) return decision.provider
  return decision.considered[0]?.family ?? null
}

export function sessionAccountWords(mainModel: string, reads: SessionAccountReads = {}): SessionAccountWords {
  const family = sessionAccountFamily(mainModel, reads)
  if (family === null) return { state: 'none' }
  const presence: PresenceWords | undefined =
    family === 'anthropic'
      ? (reads.anthropic ?? anthropicCredentialPresence)()
      : (reads.presences ?? providerFamilyPresences)().find(candidate => candidate.id === family)
  const words = presence === undefined ? undefined : presenceIdentityWords(presence)
  return words !== undefined ? { state: 'email', text: words, family } : { state: 'none' }
}
