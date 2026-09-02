// ============================================================================
//  signingTrust — the ONE trusted-key roster for Mercury artifact signatures
//
//
//  This file is deliberately tiny and does nothing else: the operator's
//  production key ceremony edits exactly this file and no other. The
//  PRODUCTION slot is a NAMED SLOT awaiting that ceremony (key custody is
//  operator-only by the lane's binding constraint — no private key material
//  ever enters the repository; only the PUBLIC key lands here).
//
//  Ceremony (operator-run):
//    1. generate an Ed25519 keypair OUTSIDE the repository
//       (`openssl genpkey -algorithm ed25519 -out mercury-signing.pem`);
//    2. derive the public key
//       (`openssl pkey -in mercury-signing.pem -pubout -outform DER | base64`);
//    3. fill PRODUCTION_SIGNING_KEY below with that base64 SPKI DER and the
//       keyId printed by `bun run scripts/updater/prove-artifact-signing.ts
//       --key-id <b64>` (sha256 of the DER bytes, first 16 hex);
//    4. commit + build + release; sign packages by exporting
//       MERCURY_SIGNING_KEY_FILE=<path-to-mercury-signing.pem> when running
//       scripts/release/package.mjs. The private key never enters the tree.
//
//  Verifiers (the launcher's shipped verify-artifact.mjs, /health, doctor)
//  compile this roster in; an artifact signed by a key absent from the
//  roster verifies as 'unrecognized-key' — stated plainly, never upgraded.
// ============================================================================

export interface TrustedSigningKey {
  /** sha256 over the SPKI DER public-key bytes, first 16 hex chars. */
  keyId: string
  /** base64 of the SPKI DER encoding of the Ed25519 public key. */
  publicKeySpkiB64: string
  /** Display label for health/verify surfaces (never secret material). */
  label: string
}

/** NAMED SLOT — the production Mercury signing key. Filled ONLY by the
 *  operator's key ceremony (see the header); null means the ceremony has not
 *  happened and every signed artifact verifies as 'unrecognized-key'. */
export const PRODUCTION_SIGNING_KEY: TrustedSigningKey | null = {
  keyId: '627b54b734ca0e72',
  publicKeySpkiB64: 'MCowBQYDK2VwAyEAR6cQX+5bl8NvZb4zwAfj45nAfuCjuwBAHWvN2a8RM7s=',
  label: 'Mercury release key (2026-08)',
}

/** The compiled-in trust roster every verifier consults. */
export function trustedSigningKeys(): TrustedSigningKey[] {
  return PRODUCTION_SIGNING_KEY ? [PRODUCTION_SIGNING_KEY] : []
}
