// ============================================================================
//  providers/credentialWall — THE CREDENTIAL WALL's one owner (ledger L25 +
//  L23's inline arm, the operator's ruling): a credential that fails
//  MID-CHAT — a sign-in the provider has revoked, a key past its cap — is
//  answered by ONE honest line naming the family and the two ways forward
//  (switch providers · reconnect), never by the wire's raw JSON. Two doors
//  read this module and no other words: the transcript's error row (the
//  first-party SDK presenter in services/api/errors.ts and the compat
//  lanes' terminal seam) and the concourse's row receipt (the live
//  composer's gate refuses a send to a walled row with the SAME line). The
//  raw payload goes to the debug log only — a transcript row never carries
//  a brace.
//
//  Two halves, PURE so a prover drives them:
//    · classifyCredentialWall — the wire facts (status + the provider's own
//      words) → the cause. The revoked-sign-in phrase is matched in BOTH
//      spellings the wire serves ("OAuth token has been revoked" inside a
//      403; "OAuth access token has been revoked" inside a 401 — the one
//      the operator saw fall through to the generic tail, envelope and
//      all); OpenRouter's per-key credit cap answers 403 "Key limit
//      exceeded".
//    · credentialWallLine — the line, one spelling per cause: the family in
//      providerDisplayName's neutral words, the reconnect door in the
//      /logins family vocabulary (the same set workerModels' refusal
//      action names — the prover holds the two literals equal).
//  observedCredentialWall reads facts the estate has ALREADY observed —
//  never a probe: the dead claude.ai sign-in (auth.ts's one predicate,
//  shared through the credential store across processes) and the polled
//  OpenRouter key cap (openrouterUsageState) or the lane's recorded
//  key-limit refusal. The route-law and store owners are required late so
//  the error presenter never pulls the model-truth graph at load.
// ============================================================================

export type CredentialWallCause = 'sign-in' | 'key-limit'

// THE MATCHERS ARE SHAPES, NOT SPELLINGS (the lead's law on this lane's
// specimen): the pre-fix presenter matched ONE phrase on ONE status
// ('OAuth token has been revoked' inside a 403) and the wire's 401 said
// 'OAuth access token has been revoked' — one word of drift reopened the
// raw-JSON hole. Each wall is a status class plus a phrase FAMILY: the
// words that must co-occur, in either order, within one clause — never a
// sentence copied from a screenshot. Both real payloads are pinned beside
// the drifts the prover invents.

/** The revoked-sign-in family: a TOKEN the provider says is REVOKED —
 *  "OAuth token has been revoked" (403), "OAuth access token has been
 *  revoked" (401), "access token was revoked", "revoked token" … Never an
 *  EXPIRED token (the refresh lap owns that word). The clause bound
 *  ([^.{}"]) keeps the two words inside one sentence of one JSON string. */
const REVOKED_SIGN_IN = /\btoken\b[^.{}"]{0,40}?\brevoked\b|\brevoked\b[^.{}"]{0,20}?\btoken\b/i
/** The key-cap family: a KEY whose LIMIT/CAP/QUOTA is EXCEEDED/REACHED —
 *  OpenRouter's "Key limit exceeded" (403), "key limit reached", "API key
 *  credit limit exceeded" … The KEY word is the fence: a bare "rate limit
 *  exceeded" is a 429's, and the status class keeps 429 out anyway. */
const KEY_LIMIT = /\bkey\b[^.{}"]{0,40}?\b(?:limit|cap|quota)\b[^.{}"]{0,30}?\b(?:exceeded|reached|hit)\b/i

/** The statuses a credential wall can ride: the auth pair and the credit
 *  status a reached cap may answer with. A rate limit (429) is never one. */
const WALL_STATUSES = new Set([401, 402, 403])

/** True when the wire text carries the revoked-sign-in family — the class
 *  string's needle, the retry ladder's and the classifier's (one needle,
 *  every reader). */
export function isRevokedSignInText(wireText: string): boolean {
  return REVOKED_SIGN_IN.test(wireText)
}

/** True when the wire text carries the key-cap family. */
export function isKeyLimitText(wireText: string): boolean {
  return KEY_LIMIT.test(wireText)
}

/** The cause a provider refusal names, from its status class and its own
 *  words; undefined when the refusal is not one of the two walls (a plain
 *  expired token, a bare 403, a rate limit — each keeps its own presenter). */
export function classifyCredentialWall(
  status: number | undefined,
  wireText: string,
): CredentialWallCause | undefined {
  if (status === undefined || !WALL_STATUSES.has(status)) return undefined
  if (REVOKED_SIGN_IN.test(wireText)) return 'sign-in'
  if (KEY_LIMIT.test(wireText)) return 'key-limit'
  return undefined
}

/** The family words /logins pre-focuses (login.tsx's parseFamilyFocus —
 *  the route ids it accepts verbatim); workerModels' LOGINS_FAMILY_WORDS
 *  is the same set for the coordinator's refusal action, and the credential
 *  wall prover holds the two literals equal. The two families with no
 *  sign-in leg name their key door instead. */
const LOGINS_FAMILY_WORDS = new Set(['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek'])

/** The reconnect door for a family — a command the product has. */
export function reconnectDoorFor(route: string): string {
  if (LOGINS_FAMILY_WORDS.has(route)) return `/logins ${route}`
  if (route === 'openai-compat') return '/router key compat'
  if (route === 'local') return '/router key local'
  return '/logins'
}

function displayNameOf(route: string): string {
  try {
    const { providerDisplayName } = require('./routeLaw.js') as typeof import('./routeLaw.js')
    return providerDisplayName(route)
  } catch {
    return route
  }
}

/** THE ONE LINE: "<Family> sign-in expired — switch providers (/model) or
 *  reconnect (/logins <family>)" · "<Family> key limit reached — switch
 *  providers (/model) or connect another key (/logins <family>)". The
 *  headless spelling names the flag and the interactive door honestly. */
export function credentialWallLine(
  route: string,
  cause: CredentialWallCause,
  opts?: { nonInteractive?: boolean },
): string {
  const name = displayNameOf(route)
  const door = reconnectDoorFor(route)
  const state = cause === 'sign-in' ? 'sign-in expired' : 'key limit reached'
  const reconnect = cause === 'sign-in' ? 'reconnect' : 'connect another key'
  if (opts?.nonInteractive === true) {
    return `${name} ${state} — switch providers (--model) or ${reconnect} (${door}, in an interactive session)`
  }
  return `${name} ${state} — switch providers (/model) or ${reconnect} (${door})`
}

/** The wall the estate has ALREADY observed for a family — never a probe.
 *  A family with no observation answers undefined (the wire speaks at the
 *  send); an unreadable store is no wall either. */
export function observedCredentialWall(route: string): CredentialWallCause | undefined {
  try {
    if (route === 'anthropic') {
      const { isAnthropicOAuthSignInExpired } = require('../../utils/auth.js') as typeof import('../../utils/auth.js')
      return isAnthropicOAuthSignInExpired() ? 'sign-in' : undefined
    }
    if (route === 'openrouter') {
      const { openrouterObservedKeyUsage } =
        require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
      const usage = openrouterObservedKeyUsage().usage
      if (
        usage !== null &&
        typeof usage.limit === 'number' &&
        typeof usage.limitRemaining === 'number' &&
        usage.limitRemaining <= 0
      ) {
        return 'key-limit'
      }
      const { laneBillingState } = require('./laneBillingState.js') as typeof import('./laneBillingState.js')
      const billing = laneBillingState('openrouter')
      if (billing.state === 'credit-exhausted' && KEY_LIMIT.test(billing.detail)) return 'key-limit'
    }
  } catch {
    // an unreadable store is no wall — the wire speaks at the send
  }
  return undefined
}

/** The row receipt's read: the wall line for the family a model id routes
 *  to, or undefined when nothing observed stands in the way. */
export function credentialWallLineForModel(modelId: string | undefined): string | undefined {
  if (modelId === undefined || modelId.trim() === '') return undefined
  try {
    const { declaredRouteOf } = require('./routeLaw.js') as typeof import('./routeLaw.js')
    const route = declaredRouteOf(modelId)
    if (route === null) return undefined
    const cause = observedCredentialWall(route)
    return cause === undefined ? undefined : credentialWallLine(route, cause)
  } catch {
    return undefined
  }
}
