/**
 * PKCE verifier/challenge and CSRF state generation (RFC 7636 S256).
 * base64url = standard base64 with `+`→`-`, `/`→`_`, padding stripped.
 */
import { createHash, randomBytes } from 'node:crypto'

/** 32 random bytes, base64url-encoded. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 of the verifier, base64url-encoded. */
export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** 32 random bytes of CSRF state, base64url-encoded. */
export function generateState(): string {
  return randomBytes(32).toString('base64url')
}
