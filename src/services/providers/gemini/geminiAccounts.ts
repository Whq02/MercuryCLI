// ============================================================================
//  providers/gemini/geminiAccounts — the Google Gemini account-source owner
// ONE account resolver over TWO
//  access sources:
//
//    1. **API key** — the documented default. REST auth is the
//       `x-goog-api-key` header; env precedence follows the documented
//       client-library convention — GOOGLE_API_KEY WINS over GEMINI_API_KEY
//       when both are set (ai.google.dev/gemini-api/docs/api-key, fetched
// — then the auth-scoped manual store
//       (utils/router/providerSecrets).
//    2. **Google OAuth** — the REAL desktop flow the live docs offer
//       (ai.google.dev/gemini-api/docs/oauth + developers.google.com/
//       identity/protocols/oauth2/native-app, both fetched):
//       authorize at https://accounts.google.com/o/oauth2/v2/auth, exchange
//       at https://oauth2.googleapis.com/token, loopback 127.0.0.1 redirect,
//       PKCE S256, scopes cloud-platform + generative-language.retriever.
//       Google issues OAuth clients per project — there is NO public shared
//       client id for third-party apps — so this flow requires the
//       OPERATOR'S OWN Google Cloud OAuth client (Desktop type): client id
//       (+optional secret — Google documents the desktop secret as not
//       confidential) via the registered env flags or stored once through
//       the connect surface. Without a client config the connect route
//       REFUSES with the honest instruction, never a fake flow. Refresh
//       tokens are "always returned for installed applications" and do not
//       rotate on use — the refresh leg is single-flight + fresh-disk-read,
//       with atomic publication (no cross-process rotation lock needed).
//
//  Laws (the openaiAccounts precedent): Mercury-owned `.gemini-auth.json`
//  under the AUTH SCOPE, durable-atomic, mode 600, versioned, unknown keys
//  preserved; secret values never enter logs/errors/records/UI; resolvers
//  cheap+sync+never-network; explicit connect is the only network act.
// ============================================================================
import { createServer, type Server } from 'node:http'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
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
import { readStoredGeminiApiKey } from '../../../utils/router/providerSecrets.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'

// ── The wire constants ──────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GOOGLE_OAUTH_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_OAUTH_TOKEN_BASE = 'https://oauth2.googleapis.com/token'
/** The documented Gemini-API OAuth scopes (ai.google.dev oauth quickstart). */
const GEMINI_OAUTH_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever'
/** Fixed loopback beside the OpenAI (:1455) and OpenRouter (:1456) flows;
 *  Google matches loopback redirects on any port, so no registration binds
 *  this number. */
const GEMINI_REDIRECT_PORT = 1457
const GEMINI_REDIRECT_URI = `http://127.0.0.1:${GEMINI_REDIRECT_PORT}/oauth2/callback`

/** Proof seams (registered in the flag registry): fixture endpoints. The
 *  quoted spellings key the flag-registry consumer-liveness sweep. */
/** One deadline per login/token exchange (the provider-call deadline law). */
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export function geminiApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_GEMINI_API_BASE']?.trim() || GEMINI_API_BASE
}
function googleOauthAuthBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_GEMINI_OAUTH_AUTH_BASE']?.trim() || GOOGLE_OAUTH_AUTH_BASE
}
function googleOauthTokenBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_GEMINI_OAUTH_TOKEN_BASE']?.trim() || GOOGLE_OAUTH_TOKEN_BASE
}

// ── Stored auth (Mercury-owned; auth-scoped; mode 600) ──────────────────────

const GEMINI_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.gemini-auth.json'

export interface GeminiStoredTokens {
  accessToken: string
  refreshToken: string
  /** epoch ms the access token expires (from the exchange's expires_in). */
  accessTokenExpiresAtMs?: number
  /** The scope string the grant actually carries, as stated. */
  scope?: string
}

/** The operator's own OAuth client (Desktop type) — id required, secret
 *  optional per Google's native-app doc. NOT a Mercury secret in the
 *  confidentiality sense, but it still never enters logs or UI. */
export interface GeminiOauthClientConfig {
  clientId: string
  clientSecret?: string
}

interface GeminiAuthFile {
  version: number
  client?: GeminiOauthClientConfig
  tokens?: GeminiStoredTokens
  lastRefreshMs?: number
  /** Operator's explicit source preference when both sources exist. */
  preferredSource?: 'oauth' | 'api-key'
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): GeminiAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as GeminiAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: GeminiAuthFile) => GeminiAuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const existing = readAuthFile() ?? { version: GEMINI_AUTH_VERSION }
  const next = mutate({ ...existing, version: GEMINI_AUTH_VERSION })
  const path = authFilePath()
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best-effort on non-POSIX */
  }
}

export function geminiAuthFileExists(): boolean {
  return existsSync(authFilePath())
}

/** Diagnostic seam — the path only, never contents. */
export function geminiAuthPathForDisplay(): string {
  return authFilePath()
}

// ── OAuth client config (env flags win; else the stored config) ─────────────

export function geminiOauthClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): (GeminiOauthClientConfig & { source: 'env' | 'stored' }) | undefined {
  const envId = env['MERCURY_GEMINI_OAUTH_CLIENT_ID']?.trim()
  if (envId) {
    const envSecret = env['MERCURY_GEMINI_OAUTH_CLIENT_SECRET']?.trim()
    return { clientId: envId, ...(envSecret ? { clientSecret: envSecret } : {}), source: 'env' }
  }
  const stored = readAuthFile()?.client
  if (stored?.clientId?.trim()) {
    return {
      clientId: stored.clientId.trim(),
      ...(stored.clientSecret?.trim() ? { clientSecret: stored.clientSecret.trim() } : {}),
      source: 'stored',
    }
  }
  return undefined
}

/** Store (or clear, with null) the operator's OAuth client config. */
/** The no-probe truth, spoken at BOTH client prompts (the face pane and the
 *  in-chat card — one spelling): this writer stores the id AS GIVEN, by law
 *  without a verification probe (no network outside a flow the operator
 *  started), so a wrong id surfaces only at the next Google sign-in — as
 *  invalid_client in the browser tab while the terminal keeps waiting (esc
 *  ends the wait). The sentence tells the operator exactly that road. */
export const GEMINI_CLIENT_STORED_UNVERIFIED_NOTE =
  'Stored as given — proved at the next Google sign-in: invalid_client in the browser tab means a wrong id (esc the wait, reopen this prompt; it starts from the stored id).'

export function writeGeminiOauthClientConfig(config: GeminiOauthClientConfig | null): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (config === null || !config.clientId.trim()) delete next.client
    else
      next.client = {
        clientId: config.clientId.trim(),
        ...(config.clientSecret?.trim() ? { clientSecret: config.clientSecret.trim() } : {}),
      }
    return next
  })
}

// ── The account view (never carries a secret) ───────────────────────────────

export type GeminiKeySource = 'env-google' | 'env-gemini' | 'stored'

export interface GeminiAccountRef {
  provider: 'gemini'
  kind: 'oauth' | 'api-key'
  /** Display label — source facts, never a secret. */
  label: string
  keySource?: GeminiKeySource
}

/**
 * The ONE Gemini API-key resolution. Precedence: GOOGLE_API_KEY over
 * GEMINI_API_KEY (the DOCUMENTED client-library convention, not a Mercury
 * choice), then the auth-scoped manual store. The VALUE never enters
 * records, logs, or errors.
 */
export function resolveGeminiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: GeminiKeySource } | undefined {
  const googleKey = env.GOOGLE_API_KEY?.trim()
  if (googleKey) return { key: googleKey, source: 'env-google' }
  const geminiKey = env.GEMINI_API_KEY?.trim()
  if (geminiKey) return { key: geminiKey, source: 'env-gemini' }
  const stored = readStoredGeminiApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export function geminiOauthConnected(): boolean {
  return Boolean(readAuthFile()?.tokens?.refreshToken)
}

/** The OAuth source's non-secret view regardless of preference (the
 *  /accounts board shows every signed-in source). */
export function geminiOauthRef(): GeminiAccountRef | undefined {
  if (!geminiOauthConnected()) return undefined
  return { provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }
}

export function readPreferredGeminiSource(): 'oauth' | 'api-key' | undefined {
  return readAuthFile()?.preferredSource
}

/** The SYNC identity of a source's current credential — a one-way digest of
 *  the key value (key source) or the stored sign-in's refresh token (OAuth
 *  source); 'none' when the source holds nothing. Per-source snapshots key
 *  on this so a relogin never reuses the departed credential's catalogue. */
export function geminiSourceIdentity(
  sourceKind: 'oauth' | 'api-key',
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (sourceKind === 'api-key') return credentialFingerprint(resolveGeminiApiKey(env)?.key)
  const tokens = readAuthFile()?.tokens
  return credentialFingerprint(tokens?.refreshToken ?? tokens?.accessToken)
}

export function writePreferredGeminiSource(kind: 'oauth' | 'api-key' | null): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (kind === null) delete next.preferredSource
    else next.preferredSource = kind
    return next
  })
}

/**
 * Resolve the ACTIVE Gemini account source. Precedence: the stored
 * preference when that source is available; else OAuth when connected; else
 * the API key when present; else undefined.
 */
export function resolveGeminiAccount(
  env: NodeJS.ProcessEnv = process.env,
): GeminiAccountRef | undefined {
  const oauth = geminiOauthRef()
  const key = resolveGeminiApiKey(env)
  const keyRef = (): GeminiAccountRef | undefined =>
    key
      ? {
          provider: 'gemini',
          kind: 'api-key',
          label:
            key.source === 'env-google'
              ? 'Gemini API key (GOOGLE_API_KEY env)'
              : key.source === 'env-gemini'
                ? 'Gemini API key (GEMINI_API_KEY env)'
                : 'Gemini API key (stored)',
          keySource: key.source,
        }
      : undefined
  const preferred = readPreferredGeminiSource()
  if (preferred === 'api-key') return keyRef() ?? oauth
  if (preferred === 'oauth') return oauth ?? keyRef()
  return oauth ?? keyRef()
}

// ── Token refresh (single-flight; Google refresh tokens do not rotate) ──────

const REFRESH_SKEW_MS = 5 * 60_000
let refreshInFlight: Promise<GeminiStoredTokens | undefined> | undefined

function tokensFresh(tokens: GeminiStoredTokens | undefined, nowMs: number): boolean {
  return Boolean(
    tokens?.accessToken &&
      tokens.accessTokenExpiresAtMs !== undefined &&
      tokens.accessTokenExpiresAtMs - nowMs > REFRESH_SKEW_MS,
  )
}

async function postGoogleToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const url = googleOauthTokenBase(env)
  let response: Response
  try {
    // The provider-call deadline law: the token exchange ends within the
    // bound. One label per family in the breach sentence — the catalogue
    // door says 'gemini' and so does this one (field F-6.3).
    response = await fetchWithProviderDeadline(fetchImpl, 'gemini', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': getUserAgent(),
      },
      body: body.toString(),
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw new Error(`google token endpoint unreachable (${url}): ${errorMessageWithCause(error)}`)
  }
  if (!response.ok) {
    // Carry Google's OAuth error code (e.g. invalid_grant) — the refresh
    // path discriminates terminal revocation from transient trouble on it.
    let oauthError = ''
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (typeof body.error === 'string' && body.error !== '') oauthError = body.error
    } catch {
      /* non-JSON error body — the status alone rides the message */
    }
    throw new Error(
      `google token endpoint returned HTTP ${response.status}${oauthError ? ` (${oauthError})` : ''}`,
    )
  }
  return (await response.json()) as Record<string, unknown>
}

function tokensFromTokenResponse(
  raw: Record<string, unknown>,
  fallbackRefreshToken: string | undefined,
  now: () => number,
): GeminiStoredTokens {
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : ''
  const refreshToken =
    typeof raw.refresh_token === 'string' && raw.refresh_token
      ? raw.refresh_token
      : (fallbackRefreshToken ?? '')
  const expiresInS = typeof raw.expires_in === 'number' ? raw.expires_in : undefined
  const scope = typeof raw.scope === 'string' ? raw.scope : undefined
  if (!accessToken) throw new Error('google token endpoint returned no access token')
  return {
    accessToken,
    refreshToken,
    ...(expiresInS !== undefined ? { accessTokenExpiresAtMs: now() + expiresInS * 1000 } : {}),
    ...(scope ? { scope } : {}),
  }
}

/**
 * The request-side OAuth token: refreshes before expiry (single-flight,
 * fresh-disk-read first — another process's refresh is adopted with zero
 * network), persists, returns undefined when not connected / no client
 * config / refresh terminally fails (typed refusal at the caller).
 */
export async function currentGeminiTokens(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Refresh even when the stored set still reads fresh by the local
   *  clock — the refresh-on-401 path: the API refused the token the clock
   *  vouched for (skew, server-side revocation), so the clock's verdict is
   *  not the truth. A set another process already rotated is adopted. */
  force?: boolean
}): Promise<GeminiStoredTokens | undefined> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const tokens = readAuthFile()?.tokens
  if (!tokens?.refreshToken) return undefined
  if (!opts?.force && tokensFresh(tokens, now())) return tokens
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      // Adopt another process's refresh when the disk already holds a fresh
      // set — Google refresh tokens do not rotate, so the only race cost is
      // a duplicate refresh POST, and this read removes even that. A forced
      // refresh adopts only a set that DIFFERS from the refused one.
      const latest = readAuthFile()?.tokens
      if (
        tokensFresh(latest, now()) &&
        (!opts?.force || latest?.accessToken !== tokens.accessToken)
      ) {
        return latest
      }
      const client = geminiOauthClientConfig(env)
      if (!client) return undefined
      const base = latest?.refreshToken ? latest : tokens
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: base.refreshToken,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      })
      const raw = await postGoogleToken(body, opts?.fetchImpl ?? getApiFetch(), env)
      const next = tokensFromTokenResponse(raw, base.refreshToken, now)
      writeAuthFile(f => ({ ...f, tokens: next, lastRefreshMs: now() }))
      return next
    } catch (error) {
      // Terminal revocation vs transient trouble: Google's invalid_grant
      // means the refresh token itself is dead (revoked / expired / account
      // changed) — keeping it would re-attempt the same doomed refresh
      // before every call and 401 at the API forever. Drop the tokens (the
      // client config survives; every surface then renders the honest
      // signed-out state whose copy routes to /logins — the re-auth hint).
      // Anything else — network trouble, 5xx — returns the stored set so
      // the request layer can attempt-and-map the 401 honestly.
      if (error instanceof Error && /\binvalid_grant\b/.test(error.message)) {
        writeAuthFile(file => {
          const next = { ...file }
          delete next.tokens
          delete next.lastRefreshMs
          return next
        })
        return undefined
      }
      return readAuthFile()?.tokens ?? tokens
    } finally {
      refreshInFlight = undefined
    }
  })()
  return refreshInFlight
}

/** Disconnect the OAuth source (tokens dropped; preference cleared when it
 *  pointed at OAuth; the stored client config survives — it is operator
 *  infrastructure, not a session credential). */
export function disconnectGeminiOauth(): void {
  writeAuthFile(file => {
    const next = { ...file }
    delete next.tokens
    delete next.lastRefreshMs
    if (next.preferredSource === 'oauth') delete next.preferredSource
    return next
  })
}

// ── Request-side resolution (base + headers for the active source) ──────────

export interface GeminiRequestAuth {
  account: GeminiAccountRef
  baseUrl: string
  /** x-goog-api-key (key source) or Authorization: Bearer (OAuth). Never
   *  logged. */
  headers: Record<string, string>
}

/** Resolve base+headers for the active (or pinned) source. Undefined when
 *  the source is unavailable — typed refusal at the caller. */
export async function resolveGeminiRequestAuth(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  sourceKind?: 'oauth' | 'api-key'
  /** Force the OAuth refresh (refresh-on-401); ignored for an API key. */
  forceRefresh?: boolean
}): Promise<GeminiRequestAuth | undefined> {
  const env = opts?.env ?? process.env
  const account = resolveGeminiAccount(env)
  const kind = opts?.sourceKind ?? account?.kind
  if (!kind) return undefined
  if (kind === 'api-key') {
    const key = resolveGeminiApiKey(env)
    if (!key) return undefined
    return {
      account: {
        provider: 'gemini',
        kind: 'api-key',
        label:
          key.source === 'env-google'
            ? 'Gemini API key (GOOGLE_API_KEY env)'
            : key.source === 'env-gemini'
              ? 'Gemini API key (GEMINI_API_KEY env)'
              : 'Gemini API key (stored)',
        keySource: key.source,
      },
      baseUrl: geminiApiBase(env),
      headers: { 'x-goog-api-key': key.key },
    }
  }
  const tokens = await currentGeminiTokens({
    ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    env,
    ...(opts?.forceRefresh ? { force: true } : {}),
  })
  if (!tokens?.accessToken) return undefined
  return {
    account: { provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' },
    baseUrl: geminiApiBase(env),
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  }
}

// ── The browser connect flow (operator client; PKCE; loopback + paste) ──────

export interface GeminiConnectHandles {
  authorizeUrl: string
  result: Promise<GeminiAccountRef>
  /** Paste-fallback completion: the full redirected URL, or `code` (state
   *  checked when present in the paste). */
  completeWithRedirect(pasted: string): void
  cancel(reason?: string): void
  /** The listener's bound port once listening (proof seam — ephemeral-port
   *  rigs read the OS assignment); undefined when not listening. */
  boundLoopbackPort(): number | undefined
}

/** The honest gate the connect surface checks BEFORE offering the flow. */
export function geminiOauthClientMissingCopy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (geminiOauthClientConfig(env)) return undefined
  return 'Google OAuth needs your own OAuth client (Google Cloud Console → Credentials → OAuth client ID, type "Desktop app"): set MERCURY_GEMINI_OAUTH_CLIENT_ID (+_SECRET) or store it from this screen. API-key sign-in needs no client.'
}

function buildGeminiAuthorizeUrl(
  env: NodeJS.ProcessEnv,
  clientId: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: GEMINI_REDIRECT_URI,
    scope: GEMINI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
  })
  return `${googleOauthAuthBase(env)}?${params.toString()}`
}

/**
 * Begin the Google OAuth connect for the Gemini lane. REFUSES (rejected
 * result + no browser) when no OAuth client config exists — the honest
 * gated state, never a fake flow. Otherwise: browser to the authorize URL,
 * code via the fixed loopback listener or the paste fallback, exchange +
 * persist, account ref resolves.
 */
/** Google's OAuth refusal codes → the operator's exact remedy. The one that
 *  bites in the field: a Desktop client on an app still in TESTING mode
 *  refuses every Google account that is not enrolled as a test user with
 *  403 access_denied — the browser tab alone never says what to do. */
export function geminiOauthErrorRemedy(code: string, description?: string): string {
  const detail = description ? ` (${description})` : ''
  if (code === 'access_denied') {
    return (
      'Google refused the sign-in: access_denied' +
      detail +
      ' — your OAuth app is in testing mode and this Google account is not one of its test users. ' +
      'In Google Cloud Console → APIs & Services → OAuth consent screen, add your account under Test users, ' +
      'or publish the app; then retry from /logins.'
    )
  }
  if (code === 'org_internal') {
    return (
      'Google refused the sign-in: org_internal' +
      detail +
      ' — the OAuth app is restricted to its own Google Workspace organization. ' +
      'Sign in with an account from that organization, or set the app user type to External in ' +
      'Google Cloud Console → OAuth consent screen; then retry from /logins.'
    )
  }
  return `Google refused the sign-in: ${code}${detail} — fix the OAuth app in Google Cloud Console, then retry from /logins.`
}

export function beginGeminiBrowserConnect(opts?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  skipBrowserOpen?: boolean
  onListenerIssue?: (message: string) => void
  /** THE ABANDON DISCLOSURE (the disclose-not-unwind ruling): an exchange
   *  already in flight when cancel() lands is let COMPLETE — the grant
   *  exists server-side, and dropping the local copy would orphan it. The
   *  store lands, the flow promise stays REJECTED (the cancel), and this
   *  fires so the surface can say so loudly. Never fired pre-fire. */
  onSettledAfterCancel?: (ref: GeminiAccountRef) => void
  /** Proof seam: bind an ephemeral lane-scoped port (0 = OS-assigned)
   *  instead of the production port — provers must never contend for the
   *  shared fixed port. BIND override only: the authorize URL and the token
   *  exchange keep the REGISTERED redirect URI (Google checks it). */
  loopbackPort?: number
}): GeminiConnectHandles {
  const env = opts?.env ?? process.env
  const requestedPort = opts?.loopbackPort ?? GEMINI_REDIRECT_PORT
  const client = geminiOauthClientConfig(env)
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const state = generateState()
  const authorizeUrl = client ? buildGeminiAuthorizeUrl(env, client.clientId, challenge, state) : ''
  const fetchImpl = opts?.fetchImpl ?? getApiFetch()

  let settle!: (ref: GeminiAccountRef) => void
  let fail!: (error: Error) => void
  const result = new Promise<GeminiAccountRef>((resolve, reject) => {
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
  const doSettle = (ref: GeminiAccountRef): void => {
    if (settled) return
    settled = true
    settle(ref)
  }
  const doFail = (error: Error): void => {
    if (settled) return
    settled = true
    fail(error)
  }

  if (!client) {
    // Settled on the next tick so callers can attach handlers first.
    setTimeout(() => fail(new Error(geminiOauthClientMissingCopy(env)!)), 0)
    return {
      authorizeUrl: '',
      result,
      completeWithRedirect: () => {},
      cancel: () => {},
      boundLoopbackPort: () => undefined,
    }
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
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: GEMINI_REDIRECT_URI,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        code_verifier: verifier,
      })
      const raw = await postGoogleToken(body, fetchImpl, env)
      const tokens = tokensFromTokenResponse(raw, undefined, Date.now)
      if (!tokens.refreshToken) {
        throw new Error(
          'google returned no refresh token — remove the app from your Google account access page and retry the connect',
        )
      }
      writeAuthFile(file => ({
        ...file,
        tokens,
        lastRefreshMs: Date.now(),
        preferredSource: 'oauth',
      }))
      // The grant landed from a sign-in (the refresh leg writes above and
      // never records): the ledger the computed default orders by.
      recordSignIn('gemini', 'oauth')
      const ref: GeminiAccountRef = { provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }
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

  const extractCode = (
    pasted: string,
  ): { code?: string; state?: string; error?: string; errorDescription?: string } => {
    const trimmed = pasted.trim()
    try {
      const url = new URL(trimmed)
      return {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      }
    } catch {
      return { code: trimmed || undefined }
    }
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${requestedPort}`)
    if (url.pathname !== '/oauth2/callback') {
      res.writeHead(404).end()
      return
    }
    // Google's own refusal rides the redirect as error= (no code at all).
    // The old handler read only code/state and answered "state mismatch" —
    // a wrong diagnosis in the tab while the terminal waited forever. The
    // named remedy settles BOTH surfaces.
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      const remedy = geminiOauthErrorRemedy(
        oauthError,
        url.searchParams.get('error_description') ?? undefined,
      )
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`Mercury: ${remedy}`)
      failTerminal(new Error(remedy))
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
    // refuse a state-valid hit (wrong client secret, expired code, no
    // refresh token), and the old immediate 200 left the tab lying while
    // the terminal spoke the failure.
    void (async () => {
      const end = await finish(code)
      if (end === 'settled' || end === 'disclosed') {
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('Mercury: Google account connected for Gemini. You can close this tab.')
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
        .end('Mercury: the Google sign-in could not complete — the terminal has the reason; retry from /logins.')
    })()
  })
  server.on('error', error => {
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

  const failTerminal = (error: Error): void => {
    if (done) return
    done = true
    server?.close()
    server = undefined
    doFail(error)
  }

  return {
    authorizeUrl,
    result,
    completeWithRedirect(pasted: string): void {
      const extracted = extractCode(pasted)
      // A pasted redirect can carry Google's refusal exactly like the
      // loopback hit — same named remedy, same settlement.
      if (extracted.error) {
        failTerminal(new Error(geminiOauthErrorRemedy(extracted.error, extracted.errorDescription)))
        return
      }
      if (!extracted.code) {
        failTerminal(new Error('no authorization code found in the pasted value'))
        return
      }
      if (extracted.state && extracted.state !== state) {
        failTerminal(new Error('pasted state does not match this sign-in attempt'))
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
      doFail(new Error(reason ?? 'gemini connect cancelled'))
    },
    boundLoopbackPort(): number | undefined {
      const address = server?.address()
      return typeof address === 'object' && address !== null ? address.port : undefined
    },
  }
}

/** Proof seam — resets module state (refresh single-flight). */
export function __resetGeminiAccountsForTest(): void {
  refreshInFlight = undefined
}
