// ============================================================================
//  providers/huggingface/huggingfaceAccounts — the Hugging Face account-
//  source owner. ONE resolver over THREE access sources, precedence env >
//  OAuth > stored paste:
//
//    1. **HF_TOKEN env** — the provider-standard variable every HF client
//       honours (huggingface.co/docs/inference-providers/index, fetched
//      ): the operator's louder word, always wins.
//    2. **Hugging Face OAuth (device code, RFC 8628)** — the Hub's own
//       sign-in (huggingface.co/docs/hub/oauth + the OpenID metadata at
//       huggingface.co/.well-known/openid-configuration, both fetched
//      ): POST {hub}/oauth/device with client_id (+scope) answers
//       {device_code, user_code, verification_uri, expires_in} (observed live:
//       verification_uri https://hf.co/oauth/device, expires_in 300, no
//       interval ⇒ the RFC default of 5s); POST {hub}/oauth/token with the
//       device_code grant polls it (authorization_pending / slow_down /
//       expired_token / access_denied / invalid_grant vocabulary — the first
//       two observed live); the refresh_token grant renews the access token.
//       The scope that covers router calls is `inference-api`; `openid
//       profile` add the identity. The official `hf auth login` speaks this
//       exact flow (huggingface_hub utils/_oauth_device.py, read).
//       CLIENT ID: the Hub supports RFC 7591 dynamic registration (POST
//       {hub}/oauth/register, unauthenticated — observed live 2026-08-22: a
//       public client with token_endpoint_auth_method 'none' is issued
//       without a secret), so Mercury registers its OWN public client once
//       per auth scope and keeps the id in the auth file; an operator pin
//       (MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID — a Mercury app registered under
//       the operator's account) wins over the self-registered id. The
//       huggingface_hub CLI's own client id is never borrowed: the consent
//       page names the app, and a borrowed id would name someone else's.
//    3. **Pasted token** — the auth-scoped provider-secret store
//       (utils/router/providerSecrets). A fine-grained token needs the
//       "Make calls to Inference Providers" permission.
//
//  Requests ride https://router.huggingface.co/v1 (bearer). Identity comes
//  from GET {hub}/api/whoami-v2 (bearer; documented on the OAuth page) — a
//  username, never a secret — and is stored beside the credential it was
//  observed for so /accounts reads it without network.
//
//  Laws (the openaiAccounts laws): Mercury-owned storage
//  `.huggingface-auth.json` under the AUTH SCOPE, mode 600, versioned,
//  unknown keys preserved; token VALUES never enter logs, errors, discovery
//  records, or UI — presence + source labels + masked tails only; resolvers
//  are cheap+sync+never-network; the connect flow and the dispatch-time
//  refresh are the only network acts.
// ============================================================================
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { readStoredHuggingfaceApiKey } from '../../../utils/router/providerSecrets.js'

// ── The wire constants (fetched 2026-08-22; see the module header) ──────────

const HF_HUB_BASE_URL = 'https://huggingface.co'
const HF_ROUTER_BASE_URL = 'https://router.huggingface.co/v1'
const HF_OAUTH_DEVICE_PATH = '/oauth/device'
const HF_OAUTH_TOKEN_PATH = '/oauth/token'
const HF_OAUTH_REGISTER_PATH = '/oauth/register'
const HF_WHOAMI_PATH = '/api/whoami-v2'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** `inference-api` is the scope that authorizes router calls; openid +
 *  profile carry the identity. */
/** One deadline per login/key exchange (the provider-call deadline law). */
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export const HF_OAUTH_SCOPE = 'openid profile inference-api'
const HF_CLIENT_NAME = 'Mercury'
/** RFC 8628 §3.5: the default poll interval when the server states none. */
const DEVICE_DEFAULT_INTERVAL_SEC = 5
/** Refresh when less than this much validity remains. The Hub's documented
 *  access-token lifetime is hours (expires_in 28800 in its token examples),
 *  so a day-sized margin would refresh on every dispatch; fifteen minutes
 *  keeps a turn's bearer valid at request time without churning the grant. */
const REFRESH_MARGIN_MS = 15 * 60 * 1000
/** The whoami probe's hard deadline (the key-probe law). */
const WHOAMI_TIMEOUT_MS = 10_000

/** Proof seams (registered in the flag registry): fixture endpoints. The
 *  quoted spellings key the flag-registry consumer-liveness sweep. */
export function huggingfaceHubBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_HUGGINGFACE_HUB_BASE']?.trim() || HF_HUB_BASE_URL).replace(/\/+$/, '')
}
export function huggingfaceRouterBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_HUGGINGFACE_API_BASE']?.trim() || HF_ROUTER_BASE_URL).replace(/\/+$/, '')
}
export function huggingfaceChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${huggingfaceRouterBase(env)}/chat/completions`
}
export function huggingfaceModelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${huggingfaceRouterBase(env)}/models`
}
/** An operator-registered Mercury OAuth app id wins over self-registration. */
export function huggingfaceOauthClientIdPin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID']?.trim() || undefined
}
/** Organization billing (X-HF-Bill-To — huggingface.co/docs/inference-
 *  providers/pricing, fetched): Team/Enterprise credits apply
 *  only when the org (or resource-group id) is named per request. */
export function huggingfaceBillTo(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['MERCURY_HUGGINGFACE_BILL_TO']?.trim() || undefined
}

// ── Stored auth (Mercury-owned; auth-scoped; mode 600) ──────────────────────

const HF_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.huggingface-auth.json'

export interface HuggingfaceStoredTokens {
  accessToken: string
  refreshToken?: string
  /** epoch ms the access token expires (from the token response). */
  accessTokenExpiresAtMs?: number
  scope?: string
}

/** Non-secret identity facts observed from whoami for a credential. */
export interface HuggingfaceIdentity {
  username: string
  fullName?: string
  observedAtMs: number
}

interface HuggingfaceAuthFile {
  version: number
  tokens?: HuggingfaceStoredTokens
  /** The identity behind the OAuth tokens. */
  identity?: HuggingfaceIdentity
  /** The identity observed for a PASTED token, keyed by its masked tail so a
   *  re-pasted different token never wears a stale name. */
  tokenIdentity?: HuggingfaceIdentity & { keyTail: string }
  /** The self-registered public OAuth client (RFC 7591), per hub base. */
  registeredClient?: { clientId: string; hubBase: string; issuedAtMs: number }
  lastRefreshMs?: number
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): HuggingfaceAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as HuggingfaceAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: HuggingfaceAuthFile) => HuggingfaceAuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const existing = readAuthFile() ?? { version: HF_AUTH_VERSION }
  const next = mutate({ ...existing, version: HF_AUTH_VERSION })
  const path = authFilePath()
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best-effort on non-POSIX */
  }
}

/** Store tokens from a completed device flow (or clear with null — the
 *  identity goes with them). */
export function writeHuggingfaceTokens(
  tokens: HuggingfaceStoredTokens | null,
  identity?: HuggingfaceIdentity,
): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (tokens === null) {
      delete next.tokens
      delete next.identity
      return next
    }
    next.tokens = tokens
    next.lastRefreshMs = Date.now()
    if (identity) next.identity = identity
    return next
  })
}

export function huggingfaceStoredTokens(): HuggingfaceStoredTokens | undefined {
  const tokens = readAuthFile()?.tokens
  return tokens && typeof tokens.accessToken === 'string' && tokens.accessToken.trim() ? tokens : undefined
}

export function huggingfaceOauthIdentity(): HuggingfaceIdentity | undefined {
  return readAuthFile()?.identity
}

export function disconnectHuggingfaceOauth(): void {
  writeHuggingfaceTokens(null)
}

/** Masked tail (the /accounts display form) — the only key-derived text. */
export function huggingfaceKeyTail(key: string | undefined): string {
  const trimmed = key?.trim() ?? ''
  return trimmed.length >= 10 ? trimmed.slice(-4) : ''
}

/** Record the identity observed for a pasted token (the connect surface
 *  proves the token live through whoami before storing). */
export function writeHuggingfaceTokenIdentity(key: string, identity: HuggingfaceIdentity | null): void {
  const keyTail = huggingfaceKeyTail(key)
  writeAuthFile(file => {
    const next = { ...file }
    if (identity === null) delete next.tokenIdentity
    else next.tokenIdentity = { ...identity, keyTail }
    return next
  })
}

/** The identity stored for the CURRENT pasted token, if its tail matches. */
export function huggingfaceStoredTokenIdentity(key: string | undefined): HuggingfaceIdentity | undefined {
  const stored = readAuthFile()?.tokenIdentity
  if (!stored || !key) return undefined
  return stored.keyTail === huggingfaceKeyTail(key) ? stored : undefined
}

// ── The OAuth client id (pinned, else self-registered once per scope) ───────

export interface HuggingfaceOauthIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}

function oauthFetch(io?: HuggingfaceOauthIo): typeof fetch {
  return io?.fetchImpl ?? getApiFetch()
}

async function postForm(
  url: string,
  form: Record<string, string>,
  io?: HuggingfaceOauthIo,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = oauthFetch(io)
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  // The provider-call deadline law: each token/device poll ends within the bound.
  const response = await fetchWithProviderDeadline(fetchImpl, 'huggingface', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': getUserAgent(),
    },
    body: new URLSearchParams(form).toString(),
    ...(proxyOptions as Record<string, unknown>),
  } as RequestInit)
  let body: Record<string, unknown> = {}
  try {
    const parsed = (await response.json()) as unknown
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    /* non-JSON error body */
  }
  return { status: response.status, body }
}

/** The stored self-registered client for the CURRENT hub base. */
export function huggingfaceRegisteredClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stored = readAuthFile()?.registeredClient
  if (!stored || typeof stored.clientId !== 'string' || !stored.clientId) return undefined
  return stored.hubBase === huggingfaceHubBase(env) ? stored.clientId : undefined
}

/** Register Mercury as a PUBLIC OAuth client on the Hub (RFC 7591; the
 *  documented Client-ID-Metadata path needs a hosted document, the dynamic
 *  endpoint needs nothing). Throws on refusal — never invents an id. */
export async function registerHuggingfaceOauthClient(io?: HuggingfaceOauthIo): Promise<string> {
  const env = io?.env ?? process.env
  const url = `${huggingfaceHubBase(env)}${HF_OAUTH_REGISTER_PATH}`
  const fetchImpl = oauthFetch(io)
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
    // The provider-call deadline law: client registration ends within the bound.
    response = await fetchWithProviderDeadline(fetchImpl, 'huggingface', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': getUserAgent(),
      },
      body: JSON.stringify({
        client_name: HF_CLIENT_NAME,
        token_endpoint_auth_method: 'none',
        grant_types: [DEVICE_GRANT, 'refresh_token'],
        redirect_uris: [],
        scope: HF_OAUTH_SCOPE,
      }),
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    throw new Error(`Hugging Face client registration unreachable (${url}): ${errorMessageWithCause(error)}`)
  }
  let body: Record<string, unknown> = {}
  try {
    const parsed = (await response.json()) as unknown
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch {
    /* non-JSON */
  }
  const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
  if ((response.status !== 201 && response.status !== 200) || !clientId) {
    throw new Error(`Hugging Face client registration refused (HTTP ${response.status})`)
  }
  writeAuthFile(file => ({
    ...file,
    registeredClient: {
      clientId,
      hubBase: huggingfaceHubBase(env),
      issuedAtMs: io?.now?.() ?? Date.now(),
    },
  }))
  return clientId
}

/** The client id the device flow uses: the operator pin, else the stored
 *  self-registration, else a fresh registration (persisted). */
export async function resolveHuggingfaceOauthClientId(io?: HuggingfaceOauthIo): Promise<string> {
  const env = io?.env ?? process.env
  const pinned = huggingfaceOauthClientIdPin(env)
  if (pinned) return pinned
  const stored = huggingfaceRegisteredClientId(env)
  if (stored) return stored
  return registerHuggingfaceOauthClient(io)
}

// ── The device flow (RFC 8628; the grant the Hub documents) ─────────────────

export interface HuggingfaceDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSec: number
  expiresAtMs: number
  /** The client id the flow runs under (non-secret; the poll reuses it). */
  clientId: string
}

export type HuggingfaceDevicePollResult =
  | { state: 'authorized'; tokens: HuggingfaceStoredTokens }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'denied'; code: string; description?: string }
  /** The Hub did not answer (transport fault) — the flow is NOT settled;
   *  the caller keeps polling until the code expires. */
  | { state: 'unreachable'; message: string }

/** Begin the device flow. Throws for a refused start (or a refused client
 *  registration) — token VALUES never ride errors. */
export async function startHuggingfaceDeviceAuth(io?: HuggingfaceOauthIo): Promise<HuggingfaceDeviceAuthStart> {
  const env = io?.env ?? process.env
  const clientId = await resolveHuggingfaceOauthClientId(io)
  const { status, body } = await postForm(
    `${huggingfaceHubBase(env)}${HF_OAUTH_DEVICE_PATH}`,
    { client_id: clientId, scope: HF_OAUTH_SCOPE },
    io,
  )
  const deviceCode = typeof body.device_code === 'string' ? body.device_code : undefined
  const userCode = typeof body.user_code === 'string' ? body.user_code : undefined
  const verificationUri = typeof body.verification_uri === 'string' ? body.verification_uri : undefined
  if (status !== 200 || !deviceCode || !userCode || !verificationUri) {
    const detail = typeof body.error === 'string' ? ` — ${body.error}` : ''
    throw new Error(`Hugging Face device authorization refused (HTTP ${status}${detail})`)
  }
  const now = io?.now?.() ?? Date.now()
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof body.verification_uri_complete === 'string'
      ? { verificationUriComplete: body.verification_uri_complete }
      : {}),
    intervalSec: typeof body.interval === 'number' ? body.interval : DEVICE_DEFAULT_INTERVAL_SEC,
    expiresAtMs: now + expiresIn * 1000,
    clientId,
  }
}

function tokensFromBody(body: Record<string, unknown>, io?: HuggingfaceOauthIo): HuggingfaceStoredTokens | undefined {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined
  if (!accessToken) return undefined
  const now = io?.now?.() ?? Date.now()
  return {
    accessToken,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === 'number' ? { accessTokenExpiresAtMs: now + body.expires_in * 1000 } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  }
}

/** One token poll. The caller owns the interval loop (slow_down ⇒ +5s per
 *  RFC 8628 §3.5). Never throws: a transport fault is the typed
 *  'unreachable' — an un-caught rejection here killed the connect screen's
 *  poll loop with the surface still painting "waiting". */
export async function pollHuggingfaceDeviceToken(
  start: Pick<HuggingfaceDeviceAuthStart, 'deviceCode' | 'clientId'>,
  io?: HuggingfaceOauthIo,
): Promise<HuggingfaceDevicePollResult> {
  const env = io?.env ?? process.env
  let posted: { status: number; body: Record<string, unknown> }
  try {
    posted = await postForm(
      `${huggingfaceHubBase(env)}${HF_OAUTH_TOKEN_PATH}`,
      { grant_type: DEVICE_GRANT, device_code: start.deviceCode, client_id: start.clientId },
      io,
    )
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
  const { status, body } = posted
  const tokens = tokensFromBody(body, io)
  if (status === 200 && tokens) return { state: 'authorized', tokens }
  const error = typeof body.error === 'string' ? body.error : `http-${status}`
  if (error === 'authorization_pending') return { state: 'pending' }
  if (error === 'slow_down') return { state: 'slow-down' }
  return {
    state: 'denied',
    code: error,
    ...(typeof body.error_description === 'string' ? { description: body.error_description } : {}),
  }
}

let refreshInFlight: Promise<HuggingfaceStoredTokens | undefined> | null = null

/** Refresh stored tokens; returns the fresh set (persisted) or undefined
 *  (refresh refused ⇒ stored tokens dropped so state stays honest; a
 *  transport failure keeps them). Single-flight. */
export function refreshHuggingfaceTokens(io?: HuggingfaceOauthIo): Promise<HuggingfaceStoredTokens | undefined> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async (): Promise<HuggingfaceStoredTokens | undefined> => {
    try {
      const env = io?.env ?? process.env
      const stored = huggingfaceStoredTokens()
      if (!stored?.refreshToken) return undefined
      const clientId = huggingfaceOauthClientIdPin(env) ?? huggingfaceRegisteredClientId(env)
      if (!clientId) return undefined
      let result: { status: number; body: Record<string, unknown> }
      try {
        result = await postForm(
          `${huggingfaceHubBase(env)}${HF_OAUTH_TOKEN_PATH}`,
          { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: clientId },
          io,
        )
      } catch {
        return undefined
      }
      const tokens = tokensFromBody(result.body, io)
      if (result.status === 200 && tokens) {
        const next = { ...tokens, refreshToken: tokens.refreshToken ?? stored.refreshToken }
        writeHuggingfaceTokens(next, huggingfaceOauthIdentity())
        return next
      }
      if (result.status === 400 || result.status === 401) writeHuggingfaceTokens(null)
      return undefined
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// ── Identity (whoami — a username, never a secret) ──────────────────────────

/** The whoami outcome, typed: a REFUSAL (the Hub answered and rejected the
 *  credential) and an UNREACHABLE Hub (transport fault) are different facts
 *  — collapsing them made an invalid pasted token indistinguishable from
 *  the network being down. */
export type HuggingfaceIdentityProbe =
  | { state: 'confirmed'; identity: HuggingfaceIdentity }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

/** GET {hub}/api/whoami-v2 with the credential — the typed probe. */
export async function fetchHuggingfaceIdentity(
  token: string,
  io?: HuggingfaceOauthIo,
): Promise<HuggingfaceIdentityProbe> {
  const env = io?.env ?? process.env
  const fetchImpl = oauthFetch(io)
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  try {
    // The identity probe is a bounded question (the key-probe law): a
    // black-holed Hub answers 'unreachable', never a wedged token screen.
    // The one deadline door carries the bound AND the honest breach words —
    // the raw runtime abort spelling never reaches the operator (field
    // F-6.2: the message renders verbatim on the connect surface).
    const response = await fetchWithProviderDeadline(
      fetchImpl,
      'huggingface',
      WHOAMI_TIMEOUT_MS,
      `${huggingfaceHubBase(env)}${HF_WHOAMI_PATH}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': getUserAgent() },
        ...(proxyOptions as Record<string, unknown>),
      } as RequestInit,
    )
    if (!response.ok) return { state: 'refused', status: response.status }
    const body = (await response.json()) as Record<string, unknown>
    const username = typeof body.name === 'string' ? body.name.trim() : ''
    if (!username) return { state: 'refused', status: response.status }
    return {
      state: 'confirmed',
      identity: {
        username,
        ...(typeof body.fullname === 'string' && body.fullname.trim() ? { fullName: body.fullname.trim() } : {}),
        observedAtMs: io?.now?.() ?? Date.now(),
      },
    }
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

// ── Account resolution (never a secret in a record) ─────────────────────────

export type HuggingfaceKeySource = 'env' | 'oauth' | 'stored'

export interface HuggingfaceAccountRef {
  kind: 'oauth' | 'api-key'
  /** Display words only (source + identity facts, never a value). */
  label: string
  keySource: HuggingfaceKeySource
  /** The observed Hub username when one was recorded for this credential. */
  username?: string
}

/** The ONE Hugging Face credential resolution: env HF_TOKEN WINS over the
 *  OAuth tokens, which win over the pasted store. Sync, never network — an
 *  OAuth token near expiry is still reported here; the dispatch resolver
 *  refreshes it. The VALUE never enters records, logs, or errors. */
export function resolveHuggingfaceApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: HuggingfaceKeySource } | undefined {
  const envKey = env.HF_TOKEN?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const oauth = huggingfaceStoredTokens()
  if (oauth) return { key: oauth.accessToken, source: 'oauth' }
  const stored = readStoredHuggingfaceApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

/** Source label for display/readiness — never the value. */
export function huggingfaceKeySource(
  env: Record<string, string | undefined> = process.env,
): HuggingfaceKeySource | undefined {
  return resolveHuggingfaceApiKey(env)?.source
}

/** The resolved account for display/slots. */
export function resolveHuggingfaceAccount(
  env: NodeJS.ProcessEnv = process.env,
): HuggingfaceAccountRef | undefined {
  const key = resolveHuggingfaceApiKey(env)
  if (!key) return undefined
  if (key.source === 'oauth') {
    const identity = huggingfaceOauthIdentity()
    return {
      kind: 'oauth',
      label: identity ? `Hugging Face account (${identity.username})` : 'Hugging Face account (OAuth device flow)',
      keySource: 'oauth',
      ...(identity ? { username: identity.username } : {}),
    }
  }
  const identity = huggingfaceStoredTokenIdentity(key.key)
  return {
    kind: 'api-key',
    label:
      key.source === 'env'
        ? `HF_TOKEN (env)${identity ? ` · ${identity.username}` : ''}`
        : `Hugging Face token (stored, auth-scoped)${identity ? ` · ${identity.username}` : ''}`,
    keySource: key.source,
    ...(identity ? { username: identity.username } : {}),
  }
}

/** The DISPATCH credential: env > OAuth (refreshed when under the margin,
 *  dropped when expired with no refresh route) > stored. Async because the
 *  refresh is a network act; undefined = the honest refusal. ONE truth with
 *  the display resolver: while the OAuth tokens stay on disk (the reported
 *  source), an unusable bearer REFUSES — it never silently falls through to
 *  a store the surfaces do not name (the wire must bill the credential the
 *  surfaces report). */
export async function resolveHuggingfaceDispatchCredential(
  io?: HuggingfaceOauthIo,
): Promise<{ apiKey: string } | undefined> {
  const env = io?.env ?? process.env
  const envKey = env.HF_TOKEN?.trim()
  if (envKey) return { apiKey: envKey }
  const oauth = huggingfaceStoredTokens()
  if (oauth) {
    const now = io?.now?.() ?? Date.now()
    const expiresAt = oauth.accessTokenExpiresAtMs
    if (expiresAt !== undefined && expiresAt - now < REFRESH_MARGIN_MS) {
      if (oauth.refreshToken) {
        const fresh = await refreshHuggingfaceTokens(io)
        if (fresh) return { apiKey: fresh.accessToken }
        // A refused refresh dropped the tokens — the store changed, every
        // surface now reports the next source, so falling through is honest.
        // A transport failure KEPT them: an unexpired token still
        // dispatches; an expired one refuses outright, because the kept
        // OAuth tokens are still what every surface reports — falling
        // through would bill a pasted token no surface names.
        const remaining = huggingfaceStoredTokens()
        if (remaining) {
          if (remaining.accessTokenExpiresAtMs === undefined || remaining.accessTokenExpiresAtMs > now) {
            return { apiKey: remaining.accessToken }
          }
          return undefined
        }
      } else if (expiresAt <= now) {
        writeHuggingfaceTokens(null)
      } else {
        return { apiKey: oauth.accessToken }
      }
    } else {
      return { apiKey: oauth.accessToken }
    }
  }
  const stored = readStoredHuggingfaceApiKey()
  return stored ? { apiKey: stored } : undefined
}

/** Diagnostic seam — the path only, never contents. */
export function huggingfaceAuthPathForDisplay(): string {
  return authFilePath()
}

/** Proof seam. */
export function __resetHuggingfaceAccountsForTest(): void {
  refreshInFlight = null
}
