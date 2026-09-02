/**
 * Operator identity — the operator and the assistant as durable principals.
 * The substrate owns "who the operator is"; the transcripts, receipts, health
 * rows and the keychain's pin-spelling adoption all consume it.
 *
 * THE KEYED GENERATION (ledger L27): the operator's principal id derives
 * from an Ed25519 public key born once in the config home (operatorKey.ts) —
 * stable across processes, resumes, folders and logins on THIS box,
 * provider-neutral by construction, and the root signed authorship builds
 * on. A resumed session (a fresh process) resolves to the SAME id, so it
 * keeps write authority over its own records.
 *
 * THE LEGACY GENERATIONS stay RECOGNIZED, never minted: before the key, the
 * id was sha256(config-home + username) — and before the home-spelling fold
 * (a Windows finding), that hash under the operator's RAW pin spelling. Records
 * keyed either way are still this operator's (`principalIdOwnsRecord`, the
 * adoption law extended to the keyed generation) until their
 * one-shot re-key touches them (the migration; an orphaned record is the
 * one unforgivable bug).
 */

import { createHash } from 'crypto'
import { getMercuryHome, rawConfigHomePinSpelling } from '../../utils/envUtils.js'
import { operatorKeyId } from './operatorKey.js'
import type { Principal } from './principal.js'

/** The stable operator principal — the KEYED id (same across processes,
 *  resumes and folders; the display name follows the login, the id never). */
export function operatorPrincipal(): Principal {
  return { id: operatorKeyId(), kind: 'operator', name: process.env.USER || 'operator' }
}

/**
 * The PRE-KEY canonical derivation: sha256(canonical config home + username),
 * the id every record minted before the keyed generation carries. Kept ONLY
 * for recognition and re-keying — nothing mints it any more.
 */
export function legacyOperatorPrincipalId(): string {
  const seed = `${getMercuryHome()}|${process.env.USER || 'operator'}`
  return `op-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

/**
 * The PRE-canonicalisation principal id. The home-spelling fold
 * (getMercuryHome rides canonicalHomeSpelling) moved the seed for any
 * operator whose MERCURY_CONFIG_DIR/MERCURY_HOME pin was spelled
 * non-canonically — a trailing separator, forward slashes, a lower-case
 * drive — so records created before the fold carry a DIFFERENT hash id that
 * is still this operator's. Null when no pin exists or the pin was already
 * canonical (nothing moved). Derived from the CALLER's own environment, so
 * it can only ever name the caller's own pre-fold self.
 */
export function rawPinOperatorPrincipalId(): string | null {
  const raw = rawConfigHomePinSpelling()
  if (raw === null || raw === getMercuryHome()) return null
  const seed = `${raw}|${process.env.USER || 'operator'}`
  return `op-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

/** Every legacy id this operator's records may be keyed by (the canonical
 *  pre-key hash, plus the pre-fold raw-pin hash when a non-canonical pin
 *  exists). Never contains the keyed id. */
export function legacyOperatorPrincipalIds(): string[] {
  const raw = rawPinOperatorPrincipalId()
  const legacy = legacyOperatorPrincipalId()
  return raw !== null && raw !== legacy ? [legacy, raw] : [legacy]
}

/** Is `id` one of this operator's LEGACY ids (a re-key candidate)? */
export function isLegacyOperatorPrincipalId(id: string): boolean {
  return legacyOperatorPrincipalIds().includes(id)
}

/**
 * Owner recognition across the identity generations — the ONE-SHOT ADOPTION
 * law (extended at the keyed generation): a record
 * owner equal to the caller's id, or equal to EITHER legacy derivation while
 * the caller IS this box's operator, belongs to the operator. Legacy ids are
 * recognized, never minted, so every new record carries the keyed id and the
 * legacy spellings age out through the one-shot re-key. Guest-safe by
 * construction: the legacy ids derive from the caller's own config home and
 * login, so a guest process can never claim a host's records through them.
 */
export function principalIdOwnsRecord(callerId: string, recordOwner: string | null): boolean {
  if (recordOwner === null) return false
  if (callerId === recordOwner) return true
  return callerId === operatorPrincipal().id && isLegacyOperatorPrincipalId(recordOwner)
}

/** The assistant's principal — the model's turns are attributed here. */
export function assistantPrincipal(): Principal {
  return { id: 'agent-mercury', kind: 'agent', name: 'Mercury' }
}
