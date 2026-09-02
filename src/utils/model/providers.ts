/**
 * The first-party base-URL predicate and the control-plane gate built on it.
 * Mercury talks to the first-party Anthropic API (directly or through an
 * ANTHROPIC_BASE_URL proxy of it); there is no third-party gateway estate
 * (Bedrock/Vertex/Foundry).
 */

/**
 * Is the configured base URL a first-party vendor host? Unset means yes; a
 * parseable URL whose host is the vendor API host means yes; anything else —
 * including an unparseable URL — means no.
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return true
  try {
    return new URL(baseUrl).host === 'api.anthropic.com'
  } catch {
    return false
  }
}

/**
 * "Talks to the vendor control plane" — the shared gate for settings sync
 * and team-memory sync.
 */
export function hasAnthropicControlPlane(): boolean {
  return isFirstPartyAnthropicBaseUrl()
}
