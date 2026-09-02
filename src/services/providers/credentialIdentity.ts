// ============================================================================
//  providers/credentialIdentity — the ONE non-reversible credential
//  fingerprint every per-provider snapshot is keyed on.
//
//  A catalogue, key-usage record or balance is a fact about ONE credential:
//  a snapshot keyed on something coarser (the source kind alone — 'env',
//  'api-key', 'chatgpt-subscription') outlives the credential that fetched
//  it, so a relogin under a different key or account repaints the departed
//  account's rows, qualification and credits until the TTL expires (the
//  class the OpenRouter catalogue closed first). The digest is
//  short and one-way; the material itself never leaves its owning resolver.
// ============================================================================
import { createHash } from 'node:crypto'

/** A 12-hex digest of credential material; 'none' when absent. */
export function credentialFingerprint(material: string | undefined | null): string {
  if (material === undefined || material === null || material === '') return 'none'
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}
