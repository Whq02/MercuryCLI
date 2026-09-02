// ============================================================================
//  daemon/saturnAccount — SATURN's PREFLIGHT OWNER: the account derivation
//  (the founding law's first-class capture) and THE ONE VERDICT FUNCTION,
//  shared verbatim by schedule time and fire time.
//
//  DERIVATION (deriveScheduleAccountForModel): the session's OWN account,
//  from the session's own modelKey — family through the route law, presence
//  through the estate's ONE enumeration owners (anthropicCredentialPresence
//  and the router snapshot's per-adapter account views; never a hand table).
//  No credential ⇒ the L26 two-door refusal, both doors named. WHO, NEVER A
//  TOKEN: the captured row carries the scope dir, the snapshot identity
//  label, the known expiry and the refresh-token EXISTENCE — no token, no
//  key, nothing secret-shaped, ever.
//
//  VERDICT (scheduleAccountVerdict): pure over explicitly-assembled live
//  facts — the same function answers the schedule-time warn (stored as
//  preflightAtWrite provenance) and the fire-time fire/hold decision; the
//  assembly (readLiveAccountFacts) is the one production reader, injectable
//  for provers. THE REFRESHABLE-EXPIRY LAW rides auth's own stranded
//  predicate: an expiry WITH a refresh token to spend is 'ready' (the
//  refresh happens at use) — only a refreshless expiry landing before the
//  fire warns, and only the OBSERVED-dead sign-in is 'expired'.
//
//  An env bearer token (ANTHROPIC_AUTH_TOKEN and kin) is credential
//  material that came through neither L26 door; the closed source union
//  spells it 'api-key' (the key-shaped door) — presence honest, oauth
//  detail absent.
// ============================================================================
import { join } from 'node:path'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { anthropicCredentialPresence } from '../services/providers/providerUsage.js'
import { buildRouterModelSnapshot } from '../utils/router/modelRegistry.js'
import { getClaudeAIOAuthTokens, isAnthropicOAuthSignInExpired, isClaudeAISubscriber } from '../utils/auth.js'
import { getAuthConfigHomeDir } from '../utils/envUtils.js'
import { readScopeIdentity } from '../utils/accounts/scopeScan.js'
import { LOCAL_UNREACHABLE_REMEDY } from '../services/providers/local/localAccounts.js'
import type { ScheduleAccountV1, ScheduleAccountVerdictV1 } from './saturn.js'

// ── the derivation ──────────────────────────────────────────────────────────

/** One family's credential presence, unified across the estate's owners:
 *  'oauth' | 'api-key' when credentialed, 'keyless' when the family's
 *  backing is a discovered auth-free server (the account-less arm —
 *  "credentialed" then means REACHABLE), 'none' when not. */
export interface FamilyCredentialPresenceV1 {
  credentialed: boolean
  kind: 'oauth' | 'api-key' | 'keyless' | 'none'
}

/** The anthropic family's oauth detail at capture (no token, ever). */
export interface AnthropicOauthDetailV1 {
  subscriber: boolean
  scopeDir: string
  identity?: string
  knownExpiresAt: number | null
  refreshable: boolean
}

/** Injectable reads — production defaults below; provers inject fixtures. */
export interface SaturnAccountReads {
  familyOf?: (modelKey: string) => string
  presenceOf?: (family: string) => FamilyCredentialPresenceV1
  anthropicDetail?: () => AnthropicOauthDetailV1 | null
}

function productionPresenceOf(family: string): FamilyCredentialPresenceV1 {
  if (family === 'anthropic') {
    // The one anthropic presence owner (providerUsage): subscription, key
    // ladder, or env bearer — existence, never validity.
    try {
      const presence = anthropicCredentialPresence()
      if (!presence.credentialed) return { credentialed: false, kind: 'none' }
      const detail = productionAnthropicDetail()
      return { credentialed: true, kind: detail !== null && detail.subscriber ? 'oauth' : 'api-key' }
    } catch {
      return { credentialed: false, kind: 'none' }
    }
  }
  // Engine families: the adapter's own account view on the router snapshot
  // (the enumeration law — a new adapter answers with no edit
  // here). Absent or 'none' = no credential. (These imports add no weight
  // the daemon graph does not already carry — workerModels rides the
  // supervisor's admit statically.)
  try {
    const provider = buildRouterModelSnapshot().providers.find(p => p.id === family)
    const account = (provider?.description as { account?: { kind?: string } } | undefined)?.account
    if (!account || account.kind === 'none' || account.kind === undefined) {
      return { credentialed: false, kind: 'none' }
    }
    // The adapter's keyless answer IS the account-less arm — never spelled
    // with the key word (a server that takes no key holds no key).
    if (account.kind === 'keyless') return { credentialed: true, kind: 'keyless' }
    return { credentialed: true, kind: account.kind === 'oauth' ? 'oauth' : 'api-key' }
  } catch {
    return { credentialed: false, kind: 'none' }
  }
}

function productionAnthropicDetail(): AnthropicOauthDetailV1 | null {
  try {
    const subscriber = ((): boolean => {
      try {
        return isClaudeAISubscriber()
      } catch {
        return false
      }
    })()
    const tokens = ((): { expiresAt: number | null; refreshToken: string | null } | null => {
      try {
        return getClaudeAIOAuthTokens()
      } catch {
        return null
      }
    })()
    const scopeDir = getAuthConfigHomeDir()
    const identity = ((): string | undefined => {
      try {
        return readScopeIdentity(join(scopeDir, '.claude.json')).email
      } catch {
        return undefined
      }
    })()
    return {
      subscriber,
      scopeDir,
      ...(identity !== undefined ? { identity } : {}),
      knownExpiresAt: tokens?.expiresAt ?? null,
      refreshable: typeof tokens?.refreshToken === 'string' && tokens.refreshToken.length > 0,
    }
  } catch {
    return null
  }
}

export type ScheduleAccountDerivation =
  | { ok: true; account: ScheduleAccountV1 }
  /** `code: 'unreachable'` marks the account-less family's miss — the
   *  backing server is gone, not a credential lack; the ticker's hold
   *  spells it as its own reason, never the signed-out borrow. */
  | { ok: false; reason: string; code?: 'unreachable' }

/** The L26 two-door sentence — both doors named wherever an account is
 *  offered (an unadvertised door is non-neutral by omission). */
export function noCredentialRefusal(family: string): string {
  return `no-credential:${family} — /logins connects an account, or /router key ${family} connects an API key`
}

/** The account-less family's OWN refusal: local presence is DISCOVERY (no
 *  login exists, the optional key is never required), so the honest doors
 *  are the probe route — the L26 sentence would name a /logins door this
 *  family does not have. */
export function localUnreachableRefusal(): string {
  return `unreachable:local — ${LOCAL_UNREACHABLE_REMEDY}`
}

/**
 * Derive the session's OWN account for a model — the daemon-side capture
 * the schedule stores (never a wire claim). Synchronous, never throws;
 * every miss is a typed refusal.
 */
export function deriveScheduleAccountForModel(
  modelKey: string,
  reads: SaturnAccountReads = {},
): ScheduleAccountDerivation {
  const familyOf = reads.familyOf ?? ((key: string) => declaredRouteOf(key) ?? '')
  const family = familyOf(modelKey)
  if (typeof family !== 'string' || family.length === 0) {
    return { ok: false, reason: `unknown-family: no provider family answers for '${modelKey}'` }
  }
  const presenceOf = reads.presenceOf ?? productionPresenceOf
  const presence = presenceOf(family)
  if (!presence.credentialed || presence.kind === 'none') {
    // The account-less family's absence is a gone SERVER, not a missing
    // credential — its refusal names the probe route and rides the typed
    // code so the fire-time hold speaks the same truth.
    if (family === 'local') return { ok: false, reason: localUnreachableRefusal(), code: 'unreachable' }
    return { ok: false, reason: noCredentialRefusal(family) }
  }
  if (presence.kind === 'keyless') {
    return { ok: true, account: { family, source: 'keyless' } }
  }
  if (family === 'anthropic' && presence.kind === 'oauth') {
    const detail = (reads.anthropicDetail ?? productionAnthropicDetail)()
    if (detail === null) {
      // The presence said oauth but the detail readers refused — capture the
      // honest minimum rather than fabricating scope facts.
      return { ok: true, account: { family, source: 'oauth' } }
    }
    return {
      ok: true,
      account: {
        family,
        source: 'oauth',
        scopeDir: detail.scopeDir,
        ...(detail.identity !== undefined ? { identity: detail.identity } : {}),
        knownExpiresAt: detail.knownExpiresAt,
        refreshable: detail.refreshable,
      },
    }
  }
  return { ok: true, account: { family, source: presence.kind === 'oauth' ? 'oauth' : 'api-key' } }
}

// ── the one verdict function ────────────────────────────────────────────────

/** The live facts a verdict is computed over — assembled by
 *  readLiveAccountFacts in production (schedule time and fire time alike);
 *  provers hand them directly. `stranded` is auth's own observed-dead
 *  predicate (expiry with no refresh token to spend), never a probe. */
export interface LiveAccountFactsV1 {
  credentialed: boolean
  stranded: boolean
  /** Live oauth expiry (null = none known / non-expiring). */
  expiresAt: number | null
  refreshable: boolean
  /** The ticker's limit signal (absent at schedule time). */
  rateLimitedUntil?: number
}

/**
 * THE ONE VERDICT — schedule time and fire time share it verbatim.
 * Severity order: signed-out (the credential is gone; the keyless arm's
 * spelling is 'unreachable' — the backing server is gone, no sign-in word)
 * · expired (observed stranded) · rate-limited (a standing window) ·
 * expiring (a refreshless known expiry landing at/before the next fire —
 * the schedule-time WARN) · ready. A refreshable expiry is READY (the
 * refresh spends at use); an api-key source never expires here (key
 * validity is the wire's to say), and a keyless source has nothing to
 * expire at all.
 */
export function scheduleAccountVerdict(args: {
  account: Pick<ScheduleAccountV1, 'source'>
  nextFireMs: number | null
  nowMs: number
  live: LiveAccountFactsV1
}): ScheduleAccountVerdictV1 {
  const { account, nextFireMs, nowMs, live } = args
  // The keyless arm's not-ready is reachability, never a sign-in word:
  // nothing was ever signed into, so 'signed-out' would borrow a family
  // this account never had.
  if (!live.credentialed) return account.source === 'keyless' ? { state: 'unreachable' } : { state: 'signed-out' }
  // `stranded` is a sign-in's observed-dead predicate — an account-less
  // source has no sign-in to strand, whatever a caller hands in.
  if (live.stranded && account.source !== 'keyless') return { state: 'expired' }
  if (live.rateLimitedUntil !== undefined && live.rateLimitedUntil > nowMs) {
    return { state: 'rate-limited', retryAt: live.rateLimitedUntil }
  }
  if (
    account.source === 'oauth' &&
    !live.refreshable &&
    live.expiresAt !== null &&
    nextFireMs !== null &&
    live.expiresAt <= nextFireMs
  ) {
    return { state: 'expiring', expiresAt: live.expiresAt, beforeFire: true }
  }
  return { state: 'ready' }
}

/** Injectable reads for the live-fact assembly. */
export interface LiveFactsReads {
  presenceOf?: (family: string) => FamilyCredentialPresenceV1
  strandedNow?: () => boolean
  anthropicDetail?: () => AnthropicOauthDetailV1 | null
  /** The ticker's standing limit window for this family, if any (S4). */
  rateLimitedUntilOf?: (family: string) => number | undefined
}

/**
 * Assemble the live facts for one account — the production half the ticker
 * and the wire arm call before scheduleAccountVerdict. Reads the SAME
 * owners the derivation reads, live (the stored capture is provenance,
 * never the fire-time truth).
 */
export function readLiveAccountFacts(
  account: Pick<ScheduleAccountV1, 'family' | 'source'>,
  reads: LiveFactsReads = {},
): LiveAccountFactsV1 {
  const presence = (reads.presenceOf ?? productionPresenceOf)(account.family)
  const stranded =
    account.family === 'anthropic' && account.source === 'oauth'
      ? (reads.strandedNow ??
          ((): boolean => {
            try {
              return isAnthropicOAuthSignInExpired()
            } catch {
              return false
            }
          }))()
      : false
  const detail =
    account.family === 'anthropic' && account.source === 'oauth'
      ? (reads.anthropicDetail ?? productionAnthropicDetail)()
      : null
  const rateLimitedUntil = reads.rateLimitedUntilOf?.(account.family)
  return {
    credentialed: presence.credentialed && presence.kind !== 'none',
    stranded,
    expiresAt: detail?.knownExpiresAt ?? null,
    refreshable: detail?.refreshable ?? false,
    ...(rateLimitedUntil !== undefined ? { rateLimitedUntil } : {}),
  }
}
