/**
 * User-Agent string helpers.
 *
 * Deliberately import-free: the SDK-bundled surfaces (bridge, cli
 * transports) take this module without dragging auth.ts — and everything
 * behind auth.ts — into their bundles.
 */

/**
 * The product identity every Mercury-owned connection presents when it
 * cannot take utils/http's turn-scoped agent (SDK-bundled surfaces, the
 * OAuth token legs, the extension source fetches): `mercury/<version>`,
 * the same spelling as every provider wire. No connection composes its own
 * agent string.
 */
export function getMercuryUserAgent(): string {
  return `mercury/${MACRO.VERSION}`
}

/**
 * The Anthropic-backend client UA: the product identity, the same spelling
 * as every other Mercury-owned connection (API bootstrap/usage/grove,
 * settings sync, policy limits, the CCR transports included).
 * Provider-side client identification rides the auth material and the
 * x-app/session headers, not this string.
 */
export function getAnthropicClientUserAgent(): string {
  return getMercuryUserAgent()
}
