// ============================================================================
//  utils/accounts/sessionAccount — WHOSE account a session bills, in the ONE
//  identity composer's words: the owner behind the boot face's account chip
//  (and any strip that names the session's sign-in).
//
//  The account follows the MAIN MODEL'S route (the routing law) to that
//  family's credential in the presence owner — never the Anthropic snapshot
//  whatever the route. A session on the computed default is the one
//  exception worth a law: while the default's row is still being composed
//  (the OpenAI live catalogue not fetched yet — the first seconds of a boot)
//  the decision reads keyless and the main model is the keyless PLACEHOLDER,
//  whose route named a family the operator had not signed into, so the chip
//  showed no account for a signed-in ChatGPT operator until an unrelated
//  re-render happened after the catalogue landed. SNAPSHOT-FIRST: the chip
//  names the sign-in the default is being composed FOR (the decision's first
//  considered credential — the most recent sign-in) at once, from the stored
//  identity, and the catalogue's own epoch repaints the strip when the row
//  settles. Only a home with no credential anywhere paints no account.
// ============================================================================
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

/** Injectable reads for the proof; production callers pass nothing. */
export interface SessionAccountReads {
  /** The operator's explicit model setting (null = the session is on the
   *  computed default). */
  modelSetting?: () => string | null
  /** The computed default's decision. */
  decision?: () => Pick<ComputedDefault, 'source' | 'provider' | 'considered'>
  /** The presence enumeration (each family's credential + identity). */
  presences?: () => readonly (PresenceWords & { id: string })[]
  /** The Anthropic family's presence alone (no whole provider snapshot). */
  anthropic?: () => PresenceWords
}

/**
 * The family whose account the session bills: the main model's declared
 * route; on the computed default, the family the decision landed on — or,
 * while no row is usable yet, the sign-in the default is being composed for
 * (the first considered credential, recency order). null when the model
 * declares no family and no sign-in exists anywhere.
 */
export function sessionAccountFamily(mainModel: string, reads: SessionAccountReads = {}): string | null {
  const route = declaredRouteOf(mainModel)
  const setting = (reads.modelSetting ?? getUserSpecifiedModelSetting)()
  if (setting !== null) return route
  const decision = (reads.decision ?? computedDefault)()
  if (decision.provider !== null) return decision.provider
  return decision.considered[0]?.family ?? null
}

/** The chip's words: the recorded identity of that family's sign-in when
 *  its owning store holds one, else the credential's plan/source label;
 *  'none' with no sign-in anywhere. */
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
