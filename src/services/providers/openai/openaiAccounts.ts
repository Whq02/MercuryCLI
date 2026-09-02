// ============================================================================
//  providers/openai/openaiAccounts — the native OpenAI account-source owner
// Mirrors the Anthropic product shape: ONE
//  account resolver over TWO access sources —
//
//    1. **ChatGPT subscription** — a Mercury-native browser OAuth connect
//       (PKCE S256 against https://auth.openai.com, the PUBLIC client id, the
//       registered fixed loopback redirect :1455/auth/callback, manual
//       paste-code fallback, device-code flow for headless) with background
//       refresh. Requests ride https://chatgpt.com/backend-api/codex (an
//       OpenAI SERVER path for subscription-scoped Responses — no local
//       Codex runtime is involved; the zero-Codex law targets the local
//       executable/App Server/session files, none of which this touches).
//    2. **OpenAI API key** — env OPENAI_API_KEY WINS (the operator's louder
//       word), else the auth-scoped provider-secret store. Requests ride
//       https://api.openai.com/v1.
//
//  Laws:
//    - Mercury-owned storage: `.openai-auth.json` under the AUTH SCOPE
//      (getAuthConfigHomeDir — per-account isolation + in-session account
//      switches for free), mode 600, versioned, unknown keys preserved.
//      NEVER reads or writes ~/.codex/auth.json (no dependence on
//      Codex session files).
//    - Values (keys/tokens) never enter logs, errors, discovery records or
//      UI — presence + source labels only (providerSecrets' law).
//    - Both sources are alternate ACCOUNT SOURCES of the same native backend;
//      allowance vs billing stay visibly distinct; no silent source change
//      mid-work (turn start CAPTURES the resolved source).
//    - Zero work while the engines mode is off (the provider-mode-off
//      contract) — connect surfaces refuse, resolvers return undefined.
//  Grounding: recorded issuer/client facts — issuer, client
//  id, scopes, PKCE, redirect, device endpoints, token/refresh grants, the
//  id_token claim nest `https://api.openai.com/auth`
//  {chatgpt_account_id, chatgpt_plan_type}, all verified against
//  the official auth docs + the Apache-2.0 reference client (protocol study
//  only).
// ============================================================================
import { createServer, type Server } from 'node:http'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { openBrowser } from '../../../utils/browser.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../../oauth/crypto.js'
import { readStoredOpenaiApiKey } from '../../../utils/router/providerSecrets.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'

// ── The wire constants ─────────

const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
/** The PUBLIC OAuth client id for ChatGPT-account sign-in from local clients. */
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** The fixed loopback redirect registered for that public client. */
const OPENAI_OAUTH_REDIRECT_PORT = 1455
const OPENAI_OAUTH_REDIRECT_URI = `http://localhost:${OPENAI_OAUTH_REDIRECT_PORT}/auth/callback`
const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
/** Subscription-scoped Responses base (an OpenAI server path — no local
 *  runtime). */
const OPENAI_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
/** API-key Responses base. */
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'

/** Proof seams (registered in the flag registry): fixture endpoints. The
 *  quoted spellings key the flag-registry consumer-liveness sweep. */
function openaiIssuerBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENAI_AUTH_BASE']?.trim() || OPENAI_AUTH_ISSUER
}
function openaiChatgptBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENAI_CHATGPT_BASE']?.trim() || OPENAI_CHATGPT_BASE_URL
}
function openaiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_OPENAI_API_BASE']?.trim() || OPENAI_API_BASE_URL
}

// ── Stored auth (Mercury-owned; auth-scoped; mode 600) ──────────────────────

const OPENAI_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.openai-auth.json'

/** One deadline per login/token request (the provider-call deadline law). */
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export interface OpenaiStoredTokens {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
  planType?: string
  /** The signed-in account's email, from the id_token's standard top-level
   *  OIDC claim (the login requests the 'email' scope). Identity display
   *  only — the row that says WHO is signed in; absent when the provider
   *  yields none. */
  email?: string
  /** epoch ms the access token expires (from its JWT exp claim). */
  accessTokenExpiresAtMs?: number
}

interface OpenaiAuthFile {
  version: number
  tokens?: OpenaiStoredTokens
  lastRefreshMs?: number
  /** Operator's explicit source preference when both sources exist. */
  preferredSource?: 'chatgpt-subscription' | 'api-key'
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): OpenaiAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as OpenaiAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: OpenaiAuthFile) => OpenaiAuthFile): void {
  const dir = getAuthConfigHomeDir()
  mkdirSync(dir, { recursive: true })
  const existing = readAuthFile() ?? { version: OPENAI_AUTH_VERSION }
  const next = mutate({ ...existing, version: OPENAI_AUTH_VERSION })
  const path = authFilePath()
  // Durable ATOMIC publication: the
  // store is SHARED by the foreground, the scribe daemon, and every engine-
  // routed child — a bare writeFileSync interleaving with another process's
  // read-modify-write could resurrect an already-rotated refresh token, and a
  // resurrected token presented to the AS reads as reuse ⇒ the whole grant
  // dies ⇒ the operator is "logged out" for no visible reason.
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best-effort on non-POSIX */
  }
}

export function openaiAuthFileExists(): boolean {
  return existsSync(authFilePath())
}

/** Diagnostic seam — the path only, never contents. */
export function openaiAuthPathForDisplay(): string {
  return authFilePath()
}

// ── JWT claim parsing (payload decode only — verification is the AS's) ──────

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The nested OpenAI auth claim object: `https://api.openai.com/auth`
 *  {chatgpt_account_id, chatgpt_plan_type, …}. */
function openaiAuthClaims(idToken: string): Record<string, unknown> {
  const payload = decodeJwtPayload(idToken)
  const nest = payload?.['https://api.openai.com/auth']
  return typeof nest === 'object' && nest !== null
    ? (nest as Record<string, unknown>)
    : {}
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

/** The ONE decode both the code exchange and the refresh ride (a refresh
 *  without a fresh id_token keeps the old one, so every captured claim
 *  survives rotation). Pure — exported as a proof seam. Beside the
 *  proprietary nested claims it captures the STANDARD top-level `email`
 *  claim the 'email' scope asks for — the identity the account rows show;
 *  a token without one stores no field (absence honest, never invented). */
export function tokensFromExchange(raw: {
  id_token: string
  access_token: string
  refresh_token: string
}): OpenaiStoredTokens {
  const claims = openaiAuthClaims(raw.id_token)
  const accountId =
    typeof claims.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : undefined
  const planType =
    typeof claims.chatgpt_plan_type === 'string' ? claims.chatgpt_plan_type : undefined
  const topLevel = decodeJwtPayload(raw.id_token)
  const emailClaim = topLevel?.email
  const email =
    typeof emailClaim === 'string' && emailClaim.trim() !== '' ? emailClaim.trim() : undefined
  const expiresAt = jwtExpiryMs(raw.access_token)
  return {
    idToken: raw.id_token,
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    ...(accountId ? { accountId } : {}),
    ...(planType ? { planType } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { accessTokenExpiresAtMs: expiresAt } : {}),
  }
}

// ── The account view (never carries a secret) ───────────────────────────────

export type OpenaiAccountSourceKind = 'chatgpt-subscription' | 'api-key'

/** The versioned non-sensitive account view (brief OpenAIAccountRef). */
export interface OpenaiAccountRef {
  provider: 'openai'
  kind: OpenaiAccountSourceKind
  /** Display label — plan/source facts, never a secret. */
  label: string
  accountId?: string
  planType?: string
  /** The signed-in account's email (identity display; never a secret). */
  email?: string
  keySource?: 'env' | 'stored'
}

export function subscriptionConnected(): boolean {
  const file = readAuthFile()
  return Boolean(file?.tokens?.refreshToken)
}

/** PRESENT-BUT-DEAD honesty for the subscription sign-in (the anthropic
 *  family's parity): a stored token set whose refresh
 *  token is BLANK is exactly the recorded invalid_grant verdict
 *  (blankDeadRefreshTokenOnDisk keeps the identity, blanks the grant) — a
 *  sign-in that EXISTS and is dead. Before this read, that state vanished
 *  whole: no slot on /accounts, "no OpenAI account" on /model — the
 *  operator was never told the sign-in expired. Identity fields ride for
 *  the surfaces' words; never a secret. */
export function openaiSubscriptionPresence(): {
  state: 'connected' | 'expired' | 'absent'
  email?: string
  planType?: string
} {
  const tokens = readAuthFile()?.tokens
  if (!tokens) return { state: 'absent' }
  const identity = {
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(tokens.planType ? { planType: tokens.planType } : {}),
  }
  return tokens.refreshToken ? { state: 'connected', ...identity } : { state: 'expired', ...identity }
}

/** The subscription source's non-secret view REGARDLESS of the active-source
 *  preference (the /accounts slots board shows every signed-in source, not
 *  only the one a dispatch would bill). Engines gating stays upstream: a dark
 *  family never reaches this read. */
export function openaiSubscriptionRef(): OpenaiAccountRef | undefined {
  const tokens = readAuthFile()?.tokens
  if (!tokens?.refreshToken) return undefined
  return {
    provider: 'openai',
    kind: 'chatgpt-subscription',
    label: tokens.planType ? `ChatGPT ${tokens.planType} subscription` : 'ChatGPT subscription',
    ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
    ...(tokens.planType ? { planType: tokens.planType } : {}),
    ...(tokens.email ? { email: tokens.email } : {}),
  }
}

export function resolveOpenaiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.OPENAI_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredOpenaiApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export function readPreferredOpenaiSource(): OpenaiAccountSourceKind | undefined {
  const file = readAuthFile()
  return file?.preferredSource
}

/** The SYNC identity of a source's current credential — a one-way digest of
 *  the key value (key source) or the stored sign-in's refresh token /
 *  account id (subscription source); 'none' when the source holds nothing.
 *  Per-source snapshots (the live catalogue and its qualification) key on
 *  this so a relogin under another account never reuses the departed
 *  account's rows. */
export function openaiSourceIdentity(
  sourceKind: OpenaiAccountSourceKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (sourceKind === 'api-key') return credentialFingerprint(resolveOpenaiApiKey(env)?.key)
  const tokens = readAuthFile()?.tokens
  return credentialFingerprint(tokens?.refreshToken ?? tokens?.accountId ?? tokens?.accessToken)
}

export function writePreferredOpenaiSource(kind: OpenaiAccountSourceKind | null): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (kind === null) delete next.preferredSource
    else next.preferredSource = kind
    return next
  })
}

/**
 * Resolve the ACTIVE OpenAI account source. Precedence: the operator's stored
 * preference when that source is actually available; else subscription when
 * connected; else API key when present; else undefined.
 */
export function resolveOpenaiAccount(
  env: NodeJS.ProcessEnv = process.env,
): OpenaiAccountRef | undefined {
  const file = readAuthFile()
  const sub = file?.tokens?.refreshToken ? file.tokens : undefined
  const key = resolveOpenaiApiKey(env)
  const preferred = file?.preferredSource

  const subscriptionRef = (): OpenaiAccountRef | undefined =>
    sub
      ? {
          provider: 'openai',
          kind: 'chatgpt-subscription',
          label: sub.planType
            ? `ChatGPT ${sub.planType} subscription`
            : 'ChatGPT subscription',
          ...(sub.accountId ? { accountId: sub.accountId } : {}),
          ...(sub.planType ? { planType: sub.planType } : {}),
          ...(sub.email ? { email: sub.email } : {}),
        }
      : undefined
  const apiKeyRef = (): OpenaiAccountRef | undefined =>
    key
      ? {
          provider: 'openai',
          kind: 'api-key',
          label: `OpenAI API key (${key.source})`,
          keySource: key.source,
        }
      : undefined

  if (preferred === 'api-key') return apiKeyRef() ?? subscriptionRef()
  if (preferred === 'chatgpt-subscription') return subscriptionRef() ?? apiKeyRef()
  return subscriptionRef() ?? apiKeyRef()
}

// ── Token refresh (background, pre-expiry) ──────────────────────────────────
//
//  CROSS-PROCESS DISCIPLINE: the
//  refresh token ROTATES on use and the store is shared by the foreground,
//  the daemon, and every engine-routed child. The in-process single-flight
//  alone let two PROCESSES race the same refresh token — the loser presents
//  an already-rotated token, the AS's reuse detection revokes the grant, and
//  every GPT surface reads "logged out" until the operator re-connects (the
//  live "needs a re-login every session" report). The law here:
//    1. decide staleness from a FRESH disk read, never a cached snapshot;
//    2. serialize refreshes across processes via a stale-safe lock file;
//    3. after acquiring the lock, RE-READ — the previous holder usually
//       rotated already, and adopting its tokens needs no network at all;
//    4. losing the lock ⇒ poll the store for the winner's rotation instead
//       of racing the endpoint;
//    5. a failed refresh re-reads the store before falling back to stale —
//       another process may have rotated successfully mid-flight.

const REFRESH_SKEW_MS = 5 * 60_000
/** A refresh lock older than this is a crashed holder — taken over. */
const REFRESH_LOCK_STALE_MS = 30_000
/** How long a lock loser polls the store for the winner's rotation. */
const REFRESH_WAIT_TOTAL_MS = 8_000
const REFRESH_WAIT_STEP_MS = 200
let refreshInFlight: Promise<OpenaiStoredTokens | undefined> | undefined

/** Refresh tokens the AS has terminally refused (invalid_grant) — never
 *  re-presented on the wire, even when the disk blank failed (auth.ts's
 *  known-dead mirror). Keyed to the exact token string, so a NEW login
 *  (new token) is unaffected. Suppresses re-POSTs only; never drops. */
const knownDeadRefreshTokens = new Set<string>()

/** TRUE only for the AS's DEFINITIVE verdict that the grant itself is dead:
 *  an HTTP 4xx token-endpoint answer whose OAuth error body says
 *  invalid_grant (RFC 6749 §5.2 — revoked/expired/reuse-killed grant).
 *  Transport faults carry no httpStatus, 5xx sits outside 4xx, and a 4xx
 *  without the exact body code carries no oauthErrorCode — none can match,
 *  so a TRANSIENT fault can never drop tokens (the incident
 *  class stays impossible by construction). */
function isTerminalGrantRefusal(error: unknown): boolean {
  const e = error as { httpStatus?: number; oauthErrorCode?: string } | null
  return (
    typeof e?.httpStatus === 'number' &&
    e.httpStatus >= 400 &&
    e.httpStatus < 500 &&
    e.oauthErrorCode === 'invalid_grant'
  )
}

/** Best-effort blank of the on-disk refresh token, only while it is still
 *  the one the failed attempt used (a concurrent login must never be
 *  clobbered — auth.ts's guard, here on a fully synchronous
 *  read→compare→atomic-publish path). A BLANK, not a delete: accountId/
 *  planType/preferredSource/unknown keys survive, and every consumer reads
 *  a blank refreshToken as disconnected, so the surfaces flip to the honest
 *  signed-out state whose refusal names /logins. */
function blankDeadRefreshTokenOnDisk(usedRefreshToken: string): void {
  try {
    if (readAuthFile()?.tokens?.refreshToken !== usedRefreshToken) return
    writeAuthFile(file => {
      const stored = file.tokens
      if (!stored || stored.refreshToken !== usedRefreshToken) return file
      return { ...file, tokens: { ...stored, refreshToken: '' } }
    })
  } catch {
    /* the known-dead set still stops re-attempts in this process */
  }
}

function refreshLockPath(): string {
  return `${authFilePath()}.refresh-lock`
}

function tokensFresh(tokens: OpenaiStoredTokens | undefined, nowMs: number): boolean {
  return Boolean(
    tokens?.accessToken &&
      tokens.accessTokenExpiresAtMs !== undefined &&
      tokens.accessTokenExpiresAtMs - nowMs > REFRESH_SKEW_MS,
  )
}

/** Try to take the cross-process refresh lock (O_EXCL create). A stale lock
 *  (crashed holder) is removed and retaken once. Never throws. */
function acquireRefreshLock(nowMs: number): boolean {
  const path = refreshLockPath()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, `${process.pid} ${nowMs}\n`)
      } finally {
        closeSync(fd)
      }
      return true
    } catch {
      // Held — stale-holder takeover: a lock whose stamp is older than the
      // stale window is a crashed process (unlink + retry ONCE).
      try {
        const stamp = readFileSync(path, 'utf8')
        const stampedAt = Number(stamp.trim().split(/\s+/)[1])
        if (Number.isFinite(stampedAt) && nowMs - stampedAt > REFRESH_LOCK_STALE_MS) {
          unlinkSync(path)
          continue
        }
      } catch {
        /* unreadable/vanished — treat as held; the wait path covers us */
      }
      return false
    }
  }
  return false
}

/** Does the lock stamp still name `pid`? A refresh that outlives the stale
 *  window loses its lock to a takeover; releasing over the successor's stamp
 *  would let a THIRD process start a concurrent refresh of a single-use
 *  token (sweep #2 item 73). Exported for the parity prover. */
export function refreshLockStampedBy(path: string, pid: number): boolean {
  try {
    const holder = Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0])
    return !Number.isFinite(holder) || holder === pid
  } catch {
    return false
  }
}

function releaseRefreshLock(): void {
  const path = refreshLockPath()
  if (!refreshLockStampedBy(path, process.pid)) return
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}

async function postTokenEndpoint(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ id_token: string; access_token: string; refresh_token: string }> {
  const url = `${openaiIssuerBase(env)}/oauth/token`
  let response: Response
  try {
    // The provider-call deadline law: the token exchange ends within the bound.
    response = await fetchWithProviderDeadline(fetchImpl, 'openai', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': getUserAgent(),
      },
      body: body.toString(),
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    // Pre-HTTP failure: name the endpoint and the CAUSE chain — a bare
    // 'fetch failed' hides DNS/TLS/refused/dispatcher faults behind one
    // opaque string.
    throw new Error(
      `openai token endpoint unreachable (${url}): ${errorMessageWithCause(error)}`,
    )
  }
  if (!response.ok) {
    // Carry the AS's OAuth error code (e.g. invalid_grant) as STRUCTURED
    // fields — the refresh path discriminates terminal revocation from
    // transient trouble on them, never on message text.
    let oauthError = ''
    try {
      const errorBody = (await response.json()) as Record<string, unknown>
      if (typeof errorBody.error === 'string') oauthError = errorBody.error
    } catch {
      /* non-JSON error body — the status alone rides the message */
    }
    const error = new Error(
      `openai token endpoint returned HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}`,
    ) as Error & { httpStatus?: number; oauthErrorCode?: string }
    error.httpStatus = response.status
    if (oauthError) error.oauthErrorCode = oauthError
    throw error
  }
  const parsed = (await response.json()) as Record<string, unknown>
  const id_token = typeof parsed.id_token === 'string' ? parsed.id_token : ''
  const access_token = typeof parsed.access_token === 'string' ? parsed.access_token : ''
  const refresh_token =
    typeof parsed.refresh_token === 'string' ? parsed.refresh_token : ''
  if (!access_token) throw new Error('openai token endpoint returned no access token')
  return { id_token, access_token, refresh_token }
}

/**
 * The request-side subscription token: refreshes in the background before
 * expiry (single-flight), persists rotated tokens, returns undefined when not
 * connected or refresh terminally fails (the caller paints the typed
 * account-not-connected refusal — never a throw on the read path).
 */
export async function currentSubscriptionTokens(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Refresh even when the stored set still reads fresh by the local
   *  clock — the refresh-on-401 path: the API refused the token the clock
   *  vouched for (skew, server-side revocation), so the clock's verdict is
   *  not the truth. A set another process already rotated is adopted. */
  force?: boolean
}): Promise<OpenaiStoredTokens | undefined> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const tokens = readAuthFile()?.tokens
  if (!tokens?.refreshToken) return undefined
  /** A stored set worth adopting without a POST: fresh by the clock, and —
   *  under force — not the very access token the API just refused. */
  const adoptable = (latest: OpenaiStoredTokens | undefined): boolean =>
    tokensFresh(latest, now()) && (!opts?.force || latest?.accessToken !== tokens.accessToken)
  if (adoptable(tokens)) return tokens
  // A token the AS already pronounced dead is never re-presented — refuse
  // without a wire POST (the caller paints the connect refusal, told once).
  if (knownDeadRefreshTokens.has(tokens.refreshToken)) return undefined
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const sleep = (ms: number): Promise<void> =>
      new Promise(resolve => {
        const t = setTimeout(resolve, ms)
        ;(t as { unref?: () => void }).unref?.()
      })
    let locked = false
    let usedRefreshToken: string | undefined
    try {
      locked = acquireRefreshLock(now())
      if (!locked) {
        // Another process is refreshing RIGHT NOW — poll the store for its
        // rotation instead of racing the endpoint with a doomed token.
        const deadline = now() + REFRESH_WAIT_TOTAL_MS
        while (now() < deadline) {
          await sleep(REFRESH_WAIT_STEP_MS)
          const latest = readAuthFile()?.tokens
          if (adoptable(latest)) return latest
        }
        // The winner never landed (wedged/crashed holder) — fall through and
        // refresh anyway; stale-lock takeover covers the crashed case next
        // time and a doomed attempt still maps to an honest 401 downstream.
      }
      // Double-check AFTER the lock: the previous holder usually rotated
      // already — adopt its tokens (no network) instead of re-spending the
      // rotation.
      const latest = readAuthFile()?.tokens
      if (adoptable(latest)) return latest
      const base = latest?.refreshToken ? latest : tokens
      if (knownDeadRefreshTokens.has(base.refreshToken)) return undefined
      usedRefreshToken = base.refreshToken
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OPENAI_OAUTH_CLIENT_ID,
        refresh_token: base.refreshToken,
      })
      const raw = await postTokenEndpoint(body, opts?.fetchImpl ?? getApiFetch(), env)
      const next = tokensFromExchange({
        id_token: raw.id_token || base.idToken,
        access_token: raw.access_token,
        refresh_token: raw.refresh_token || base.refreshToken,
      })
      writeAuthFile(f => ({ ...f, tokens: next, lastRefreshMs: now() }))
      return next
    } catch (error) {
      // Refresh failed — another process may have rotated successfully while
      // we were in flight: prefer the store's CURRENT set over our stale
      // snapshot (newness judged against the token THIS attempt spent — the
      // auth.ts invariant: an invalid_grant marks the token the attempt
      // actually used dead, never a bystander).
      const latest = readAuthFile()?.tokens
      if (
        latest?.refreshToken &&
        (tokensFresh(latest, now()) ||
          (usedRefreshToken !== undefined && latest.refreshToken !== usedRefreshToken))
      ) {
        return latest
      }
      // The AS's DEFINITIVE verdict that the grant is dead: keeping the set
      // would re-present a dead grant on every turn forever (the zombie
      // class). Mirror auth.ts — record it dead, blank it on disk only while
      // it is still the stored one, refuse; the next resolution reads
      // disconnected and the caller paints the /logins refusal.
      if (usedRefreshToken !== undefined && isTerminalGrantRefusal(error)) {
        knownDeadRefreshTokens.add(usedRefreshToken)
        blankDeadRefreshTokenOnDisk(usedRefreshToken)
        return undefined
      }
      // Every OTHER fault — network, 5xx, a 4xx without the verdict body —
      // keeps the stored set so the request layer can attempt-and-map the
      // 401 honestly and the next call retries the refresh; a transient
      // fault NEVER drops tokens (the incident class). The
      // connect surface owns re-auth.
      return latest?.refreshToken ? latest : tokens
    } finally {
      if (locked) releaseRefreshLock()
      refreshInFlight = undefined
    }
  })()
  return refreshInFlight
}

/** Disconnect the subscription source (tokens dropped; preference cleared when
 *  it pointed at the subscription). API-key storage is providerSecrets'. */
export function disconnectOpenaiSubscription(): void {
  writeAuthFile(file => {
    const next = { ...file }
    delete next.tokens
    delete next.lastRefreshMs
    if (next.preferredSource === 'chatgpt-subscription') delete next.preferredSource
    return next
  })
}

// ── The browser connect flow (Mercury-native; PKCE; fixed loopback port) ────

export interface OpenaiConnectHandles {
  /** The URL to open/show. Manual completion: the operator pastes the
   *  redirect URL or code#state through completeWithRedirect(). */
  authorizeUrl: string
  /** Resolves when the flow completes (listener redirect OR manual paste). */
  result: Promise<OpenaiAccountRef>
  /** Paste-fallback completion: accepts the full redirected URL or a raw
   *  `code` (+optional state check). */
  completeWithRedirect(pasted: string): void
  /** Abort the flow (closes the loopback listener; result rejects). */
  cancel(reason?: string): void
  /** The listener's bound port once listening (proof seam — ephemeral-port
   *  rigs read the OS assignment); undefined when not listening. */
  boundLoopbackPort(): number | undefined
}

function buildAuthorizeUrl(env: NodeJS.ProcessEnv, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'mercury',
  })
  return `${openaiIssuerBase(env)}/oauth/authorize?${params.toString()}`
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<OpenaiStoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  })
  const raw = await postTokenEndpoint(body, fetchImpl, env)
  return tokensFromExchange(raw)
}

/**
 * Begin the ChatGPT-subscription browser connect. Opens (or hands back) the
 * authorize URL; captures the code via the fixed loopback listener or the
 * paste fallback; exchanges + persists; resolves the account ref. The
 * loopback server exists only for the flow's lifetime.
 */
export function beginOpenaiBrowserConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** Skip openBrowser() — caller shows the URL (board/headless surfaces). */
  skipBrowserOpen?: boolean
  /** Loopback listener trouble (port busy) — the flow STAYS alive on the
   *  paste fallback; the caller may surface the note. */
  onListenerIssue?: (message: string) => void
  /** THE ABANDON DISCLOSURE (the disclose-not-unwind ruling): an exchange
   *  already in flight when cancel() lands is let COMPLETE — the grant
   *  exists server-side, and dropping the local copy would orphan it. The
   *  store lands, the flow promise stays REJECTED (the cancel), and this
   *  fires so the surface can say so loudly. Never fired pre-fire. */
  onSettledAfterCancel?: (ref: OpenaiAccountRef) => void
  /** Proof seam: bind an ephemeral lane-scoped port (0 = OS-assigned)
   *  instead of the production :1455 — provers must never contend for the
   *  shared fixed port. BIND override only: the authorize URL and the token
   *  exchange keep the REGISTERED redirect URI. */
  loopbackPort?: number
}): OpenaiConnectHandles {
  const env = opts?.env ?? process.env
  const requestedPort = opts?.loopbackPort ?? OPENAI_OAUTH_REDIRECT_PORT
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const state = generateState()
  const authorizeUrl = buildAuthorizeUrl(env, challenge, state)
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()

  let settle!: (ref: OpenaiAccountRef) => void
  let fail!: (error: Error) => void
  const result = new Promise<OpenaiAccountRef>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let server: Server | undefined
  let done = false
  let exchangeInFlight = false
  let cancelledMidExchange = false
  // One-settle discipline: the promise settles exactly once, and ONLY the
  // cancel door may reject it while `done` guards a running exchange —
  // before this, a cancel during the exchange was a full no-op and the
  // promise later RESOLVED as success on an abandoned flow.
  let settled = false
  const doSettle = (ref: OpenaiAccountRef): void => {
    if (settled) return
    settled = true
    settle(ref)
  }
  const doFail = (error: Error): void => {
    if (settled) return
    settled = true
    fail(error)
  }

  /** The typed end every completion road reports (the listener answers the
   *  tab BY OUTCOME — a 'connected' claim before the exchange settles lies
   *  to the operator whenever the token endpoint refuses). 'disclosed' =
   *  the cancelled-mid-exchange landing: stored, promise kept rejected, the
   *  surface told — the tab may honestly say connected. */
  const finish = async (code: string): Promise<'settled' | 'disclosed' | 'failed' | 'ignored'> => {
    if (done) return 'ignored'
    done = true
    exchangeInFlight = true
    try {
      const tokens = await exchangeAuthorizationCode(code, verifier, fetchImpl, env)
      writeAuthFile(file => ({
        ...file,
        tokens,
        lastRefreshMs: Date.now(),
        preferredSource: 'chatgpt-subscription',
      }))
      // The grant landed from a sign-in (a refresh writes above and never
      // records): the ledger the computed default orders by.
      recordSignIn('openai', 'subscription')
      const resolved = resolveOpenaiAccount(env)
      const ref: OpenaiAccountRef =
        resolved && resolved.kind === 'chatgpt-subscription'
          ? resolved
          : {
              provider: 'openai',
              kind: 'chatgpt-subscription',
              label: tokens.planType
                ? `ChatGPT ${tokens.planType} subscription`
                : 'ChatGPT subscription',
              ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
              ...(tokens.planType ? { planType: tokens.planType } : {}),
            }
      if (cancelledMidExchange) {
        // The grant exists server-side and is now stored; the flow was
        // cancelled, so the promise stays rejected and the surface hears
        // about the landing through the typed disclosure.
        opts?.onSettledAfterCancel?.(ref)
        return 'disclosed'
      }
      doSettle(ref)
      return 'settled'
    } catch (error) {
      doFail(error instanceof Error ? error : new Error(String(error)))
      return 'failed'
    } finally {
      exchangeInFlight = false
      server?.close()
      server = undefined
    }
  }

  const extractCode = (pasted: string): { code?: string; state?: string } => {
    const trimmed = pasted.trim()
    try {
      const url = new URL(trimmed)
      return {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
      }
    } catch {
      const [code, pastedState] = trimmed.split('#')
      return { code: code || undefined, state: pastedState || undefined }
    }
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${requestedPort}`)
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404).end()
      return
    }
    const gotState = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (!code || gotState !== state) {
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('Mercury: sign-in state mismatch — return to the terminal and retry.')
      return
    }
    // The tab answers by OUTCOME (the openrouter listener's law): 'connected'
    // only once the exchange has settled — the token endpoint can still
    // refuse a state-valid hit, and the old immediate 200 left the tab
    // lying while the terminal spoke the failure.
    void (async () => {
      const end = await finish(code)
      if (end === 'settled' || end === 'disclosed') {
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('Mercury: OpenAI account connected. You can close this tab.')
        return
      }
      if (end === 'ignored') {
        res
          .writeHead(409, { 'content-type': 'text/plain' })
          .end('Mercury: a sign-in exchange is already underway — return to the terminal.')
        return
      }
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('Mercury: the OpenAI sign-in could not complete — the terminal has the reason; retry from /logins.')
    })()
  })
  server.on('error', error => {
    // A bind failure (:1455 already taken) must NOT kill the flow — the
    // redirect URL still lands in the browser's address bar, so the paste
    // fallback completes the sign-in. Cancellation/paste settle the promise.
    server?.close()
    server = undefined
    opts?.onListenerIssue?.(
      `loopback listener unavailable (${error instanceof Error ? error.message : String(error)}) — finish by pasting the redirected URL`,
    )
    if (!opts?.skipBrowserOpen) void openBrowser(authorizeUrl)
  })
  server.listen(requestedPort, '127.0.0.1', () => {
    if (!opts?.skipBrowserOpen) void openBrowser(authorizeUrl)
  })
  server.unref?.()

  return {
    authorizeUrl,
    result,
    completeWithRedirect(pasted: string): void {
      const extracted = extractCode(pasted)
      // A paste refusal is TERMINAL (done + listener closed): a rejected
      // flow that later accepted a stray redirect would store silently
      // under an already-settled promise — the same hole the cancel arm
      // closes, through a different door.
      if (!extracted.code) {
        done = true
        server?.close()
        server = undefined
        doFail(new Error('no authorization code found in the pasted value'))
        return
      }
      if (extracted.state && extracted.state !== state) {
        done = true
        server?.close()
        server = undefined
        doFail(new Error('pasted state does not match this sign-in attempt'))
        return
      }
      void finish(extracted.code)
    },
    cancel(reason?: string): void {
      // A cancel ALWAYS rejects the flow — past the done-guard, because
      // finish holds `done` while its exchange runs. An exchange already in
      // flight is let complete; its landing discloses through
      // onSettledAfterCancel. Only cancel gets this power: every other
      // terminal door keeps the done-guard, so a stray redirect can never
      // reject a running exchange into a silent store.
      if (exchangeInFlight) cancelledMidExchange = true
      done = true
      server?.close()
      server = undefined
      doFail(new Error(reason ?? 'openai connect cancelled'))
    },
    boundLoopbackPort(): number | undefined {
      const address = server?.address()
      return typeof address === 'object' && address !== null ? address.port : undefined
    },
  }
}

// ── Device-code flow (headless environments) ────────────────────────────────

export interface OpenaiDeviceConnectStart {
  userCode: string
  verifyHint: string
  /** Poll until the operator approves; then exchanged + persisted. */
  result: Promise<OpenaiAccountRef>
}

export async function beginOpenaiDeviceConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  pollIntervalMsOverride?: number
  maxWaitMs?: number
}): Promise<OpenaiDeviceConnectStart> {
  const env = opts?.env ?? process.env
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()
  const base = openaiIssuerBase(env)
  // The provider-call deadline law: the device-auth start ends within the bound.
  const startResponse = await fetchWithProviderDeadline(fetchImpl, 'openai', LOGIN_EXCHANGE_TIMEOUT_MS, `${base}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': getUserAgent() },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
    ...(getProxyFetchOptions() as Record<string, unknown>),
  } as RequestInit)
  if (!startResponse.ok) {
    throw new Error(`openai device authorization unavailable (HTTP ${startResponse.status})`)
  }
  const started = (await startResponse.json()) as Record<string, unknown>
  const userCode = String(started.user_code ?? started.usercode ?? '')
  const deviceAuthId = String(started.device_auth_id ?? '')
  const intervalS = Number(started.interval ?? 5)
  if (!userCode) throw new Error('openai device authorization returned no user code')

  const result = (async (): Promise<OpenaiAccountRef> => {
    const deadline = Date.now() + (opts?.maxWaitMs ?? 15 * 60_000)
    const intervalMs = opts?.pollIntervalMsOverride ?? Math.max(1, intervalS) * 1000
    for (;;) {
      if (Date.now() > deadline) {
        // The code's own lifetime ran out — the operator never approved it.
        // Not a wire timeout (the polls answered), so the sentence says
        // EXPIRED, the Kimi device wait's own spelling; 'timed out … did
        // not answer' stays reserved for a provider that went silent.
        throw new Error('OpenAI sign-in expired before the code was approved — retry from /logins openai')
      }
      await new Promise(resolve => {
        const t = setTimeout(resolve, intervalMs)
        ;(t as { unref?: () => void }).unref?.()
      })
      // Each poll carries its own deadline; the flow's 15-minute cap stays
      // the outer bound.
      const poll = await fetchWithProviderDeadline(fetchImpl, 'openai', LOGIN_EXCHANGE_TIMEOUT_MS, `${base}/deviceauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': getUserAgent() },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        ...(getProxyFetchOptions() as Record<string, unknown>),
      } as RequestInit)
      // 404/428/425 code "authorization still pending" on this wire (status-
      // coded, unlike the RFC 8628 body vocabulary hf/moonshot speak).
      if (poll.status === 404 || poll.status === 428 || poll.status === 425) continue
      if (!poll.ok) {
        // A DENIED approval is terminal — the hf/moonshot device flows'
        // classification: polling a refusal to the 15-minute deadline hides
        // the verdict from the operator. Terminal verdicts are the RFC
        // denial vocabulary (access_denied / expired_token) or a bare 403;
        // transient trouble (5xx, unclassified 4xx noise) keeps polling,
        // bounded by the flow deadline.
        let verdict: string | undefined
        try {
          const errorBody = (await poll.json()) as Record<string, unknown>
          if (typeof errorBody.error === 'string' && errorBody.error !== '') {
            verdict = errorBody.error
          }
        } catch {
          /* unparseable body — the status alone decides */
        }
        if (verdict === 'access_denied' || verdict === 'expired_token' || poll.status === 403) {
          throw new Error(
            `openai device authorization denied (${verdict ?? `HTTP ${poll.status}`}) — the sign-in was refused; run the connect again to retry`,
          )
        }
        continue
      }
      const body = (await poll.json()) as Record<string, unknown>
      const code = typeof body.authorization_code === 'string' ? body.authorization_code : ''
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : ''
      if (!code || !verifier) continue
      const exchange = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
        client_id: OPENAI_OAUTH_CLIENT_ID,
        code_verifier: verifier,
      })
      const raw = await postTokenEndpoint(exchange, fetchImpl, env)
      const tokens = tokensFromExchange(raw)
      writeAuthFile(file => ({
        ...file,
        tokens,
        lastRefreshMs: Date.now(),
        preferredSource: 'chatgpt-subscription',
      }))
      recordSignIn('openai', 'subscription')
      const ref = resolveOpenaiAccount(env)
      if (ref?.kind === 'chatgpt-subscription') return ref
      return {
        provider: 'openai',
        kind: 'chatgpt-subscription',
        label: 'ChatGPT subscription',
        ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      }
    }
  })()

  return {
    userCode,
    verifyHint: `${base} → sign in, then enter code ${userCode}`,
    result,
  }
}

// ── Request-side resolution (base + headers for the ACTIVE source) ──────────

export interface OpenaiRequestAuth {
  account: OpenaiAccountRef
  baseUrl: string
  /** Authorization (+ChatGPT-Account-Id for subscription). Never logged. */
  headers: Record<string, string>
}

/** Resolve base+headers for the CAPTURED account source of a turn/dispatch.
 *  Returns undefined when the source is not available (typed refusal at the
 *  caller). */
export async function resolveOpenaiRequestAuth(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** Pin the source (turn-start capture) instead of re-resolving preference. */
  sourceKind?: OpenaiAccountSourceKind
  /** Force the subscription refresh (refresh-on-401); ignored for a key. */
  forceRefresh?: boolean
}): Promise<OpenaiRequestAuth | undefined> {
  const env = opts?.env ?? process.env
  const account = resolveOpenaiAccount(env)
  const kind = opts?.sourceKind ?? account?.kind
  if (!kind) return undefined
  if (kind === 'api-key') {
    const key = resolveOpenaiApiKey(env)
    if (!key) return undefined
    return {
      account: {
        provider: 'openai',
        kind: 'api-key',
        label: `OpenAI API key (${key.source})`,
        keySource: key.source,
      },
      baseUrl: openaiApiBase(env),
      headers: { authorization: `Bearer ${key.key}` },
    }
  }
  const tokens = await currentSubscriptionTokens({
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    env,
    ...(opts?.forceRefresh ? { force: true } : {}),
  })
  if (!tokens?.accessToken) return undefined
  return {
    account: {
      provider: 'openai',
      kind: 'chatgpt-subscription',
      label: tokens.planType
        ? `ChatGPT ${tokens.planType} subscription`
        : 'ChatGPT subscription',
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      ...(tokens.planType ? { planType: tokens.planType } : {}),
    },
    baseUrl: openaiChatgptBase(env),
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      ...(tokens.accountId ? { 'ChatGPT-Account-Id': tokens.accountId } : {}),
    },
  }
}

/** Proof seam — resets module state (refresh single-flight + known-dead). */
export function __resetOpenaiAccountsForTest(): void {
  refreshInFlight = undefined
  knownDeadRefreshTokens.clear()
}
