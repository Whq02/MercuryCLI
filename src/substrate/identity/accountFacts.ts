/**
 * Account facts — the neutral, read-only view of which provider FAMILIES
 * this operator holds credentials for, attached to the identity (ledger L27
 * item 8: "usage stays on my account" is a FACT the multi-auth agents read,
 * not a probe they run).
 *
 * Sourced from the ONE presence owner (services/providers/providerUsage) —
 * EXISTENCE, never validity, and never a secret: the owner's contract
 * already forbids key material on its surface, and this view narrows it
 * further to {family id · credentialed · display label}. The poison pin
 * (scripts/operator-identity) plants a live key string in the environment
 * and asserts it is unreachable through the serialized view.
 *
 * Async and lazily imported: identity's synchronous core (the key, the
 * principal, the adoption law) must not pay the provider registry's weight.
 */

import { operatorPrincipal } from './identity.js'
import { ensureOperatorKey } from './operatorKey.js'
import type { Principal } from './principal.js'

export interface OperatorAccountFact {
  /** The provider FAMILY id (the presence owner's vocabulary). */
  id: string
  /** A credential EXISTS for this family (existence — never validity). */
  credentialed: boolean
  /** The owning resolver's display words (plan/source facts, no secret). */
  label?: string
}

export interface OperatorAccountFacts {
  families: OperatorAccountFact[]
}

/** The families this operator holds credentials for, as neutral facts. */
export async function operatorAccountFacts(): Promise<OperatorAccountFacts> {
  const { providerFamilyPresences } = await import('../../services/providers/providerUsage.js')
  return {
    families: providerFamilyPresences().map(f => ({
      id: f.id as string,
      credentialed: f.credentialed,
      ...(f.credentialLabel !== undefined ? { label: f.credentialLabel } : {}),
    })),
  }
}

/** The attachable identity view: who the operator is, the public half the
 *  authorship verifies against, and the account facts — no secret anywhere. */
export interface OperatorIdentityView {
  principal: Principal
  /** base64url of the raw 32-byte Ed25519 public key. */
  publicKey: string
  createdAt: number
  accounts: OperatorAccountFacts
}

export async function operatorIdentity(): Promise<OperatorIdentityView> {
  const key = ensureOperatorKey()
  return {
    principal: operatorPrincipal(),
    publicKey: key.publicKeyRaw.toString('base64url'),
    createdAt: key.createdAt,
    accounts: await operatorAccountFacts(),
  }
}
