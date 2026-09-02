// ============================================================================
//  providers/moonshot/moonshotAccounts — the Moonshot/Kimi account-source
//  owner. ONE resolver over THREE access sources, precedence env > Kimi
//  sign-in > stored key (the huggingfaceAccounts shape):
//
//    1. **MOONSHOT_API_KEY env** — the operator's louder word, always wins.
//       Requests ride the platform base https://api.moonshot.ai/v1
//       (platform.kimi.ai docs; platform.moonshot.ai 301s onto it).
//    2. **Kimi managed account (OAuth device code, RFC 8628)** — the sign-in
//       Moonshot's own open-source client speaks (github.com/MoonshotAI/
//       kimi-code, packages/oauth/src/{constants,region,oauth}.ts, read
//      ): a PUBLIC client id 17e5f671-d194-4dfb-9706-5516cb48c098
//       shared by both regions; POST {host}/api/oauth/device_authorization
//       with client_id answers {device_code, user_code, verification_uri,
//       verification_uri_complete?, expires_in, interval}; POST
//       {host}/api/oauth/token with the device_code grant polls it
//       (authorization_pending / slow_down / expired_token / access_denied);
//       the refresh_token grant renews. Two REGIONS, each its own host pair:
//       global — https://auth.kimi.ai + https://api.kimi.ai/coding/v1;
//       mainland China — https://auth.kimi.com + https://api.kimi.com/coding/v1.
//       The region is the operator's choice on the /logins card and is
//       remembered with the login; a managed account DISPATCHES on its
//       region's coding base with the bearer token, never on the platform
//       base, and its usage rides GET {coding base}/usages (moonshotUsageState).
//    3. **Stored Moonshot API key** — the auth-scoped provider-secret store
//       (utils/router/providerSecrets); the platform base, like the env key.
//
//  Laws (the openaiAccounts laws): Mercury-owned storage `.moonshot-auth.json`
//  under the AUTH SCOPE, mode 600, versioned, unknown keys preserved; token/
//  key VALUES never enter logs, errors, discovery records, or UI — presence +
//  source labels + masked tails only; resolvers are cheap+sync+never-network
//  except the dispatch resolver's refresh; every endpoint base is fixture-
//  pinnable by env (MERCURY_MOONSHOT_API_BASE · MERCURY_MOONSHOT_OAUTH_BASE ·
//  MERCURY_MOONSHOT_CODING_BASE), so a prover never reaches a live host.
// ============================================================================
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { readStoredMoonshotApiKey } from '../../../utils/router/providerSecrets.js'

// ── The wire constants (MoonshotAI/kimi-code packages/oauth/src, read)

const MOONSHOT_API_BASE_URL = 'https://api.moonshot.ai/v1'
/** RFC 8628 paths (packages/oauth/src/oauth.ts). */
const MOONSHOT_DEVICE_AUTH_PATH = '/api/oauth/device_authorization'
const MOONSHOT_TOKEN_PATH = '/api/oauth/token'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** The published PUBLIC client id (packages/oauth/src/constants.ts) — one id
 *  for both regions; Moonshot's own client ships it in the open. */
/** One deadline per login/token exchange (the provider-call deadline law). */
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
/** RFC 8628 §3.5: the poll interval when the server states none. */
const DEVICE_DEFAULT_INTERVAL_SEC = 5
/** Refresh when less than this much validity remains (the Hugging Face
 *  margin: a turn's bearer stays valid at request time without churning). */
const REFRESH_MARGIN_MS = 15 * 60 * 1000

/** The two deployments Moonshot's client knows (packages/oauth/src/region.ts). */
export type KimiRegion = 'global' | 'mainland-cn'
export const KIMI_REGIONS: readonly KimiRegion[] = ['global', 'mainland-cn']

const KIMI_REGION_PROFILES: Record<
  KimiRegion,
  { oauthHost: string; codingBase: string; label: string }
> = {
  global: {
    oauthHost: 'https://auth.kimi.ai',
    codingBase: 'https://api.kimi.ai/coding/v1',
    label: 'global (kimi.ai)',
  },
  'mainland-cn': {
    oauthHost: 'https://auth.kimi.com',
    codingBase: 'https://api.kimi.com/coding/v1',
    label: 'mainland China (kimi.com)',
  },
}

export function isKimiRegion(value: unknown): value is KimiRegion {
  return value === 'global' || value === 'mainland-cn'
}

/** Display words for a region — never a host a prover could mistake for config. */
export function kimiRegionLabel(region: KimiRegion): string {
  return KIMI_REGION_PROFILES[region].label
}

/** Proof seams (registered in the flag registry): fixture endpoints. The
 *  quoted spellings key the flag-registry consumer-liveness sweep. */
export function moonshotApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_MOONSHOT_API_BASE']?.trim() || MOONSHOT_API_BASE_URL).replace(/\/+$/, '')
}
export function moonshotChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${moonshotApiBase(env)}/chat/completions`
}
/** The OAuth host for a region: unset ⇒ the verified region host; set ⇒ the
 *  loopback fixture (both regions, so a prover pins ONE host). */
export function moonshotOauthBase(region: KimiRegion, env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_MOONSHOT_OAUTH_BASE']?.trim() || KIMI_REGION_PROFILES[region].oauthHost).replace(
    /\/+$/,
    '',
  )
}
/** The public client id: the published constant unless an operator-issued
 *  client is pinned (MERCURY_MOONSHOT_OAUTH_CLIENT_ID). */
export function moonshotOauthClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_MOONSHOT_OAUTH_CLIENT_ID']?.trim() || KIMI_OAUTH_CLIENT_ID
}
/** The managed account's dispatch + usage base for a region: unset ⇒ the
 *  verified coding base; set ⇒ the loopback fixture. */
export function kimiCodingBase(region: KimiRegion, env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_MOONSHOT_CODING_BASE']?.trim() || KIMI_REGION_PROFILES[region].codingBase).replace(
    /\/+$/,
    '',
  )
}
export function kimiCodingChatCompletionsUrl(region: KimiRegion, env: NodeJS.ProcessEnv = process.env): string {
  return `${kimiCodingBase(region, env)}/chat/completions`
}
export function kimiUsagesUrl(region: KimiRegion, env: NodeJS.ProcessEnv = process.env): string {
  return `${kimiCodingBase(region, env)}/usages`
}

// ── Stored auth (Mercury-owned; auth-scoped; mode 600) ──────────────────────

const MOONSHOT_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.moonshot-auth.json'

export interface MoonshotStoredTokens {
  accessToken: string
  refreshToken?: string
  /** epoch ms the access token expires (from the token response). */
  accessTokenExpiresAtMs?: number
  scope?: string
}

interface MoonshotAuthFile {
  version: number
  tokens?: MoonshotStoredTokens
  /** The region the sign-in was made in — the host pair every later act on
   *  the login (refresh · dispatch · usage) derives from. Kept across a
   *  disconnect so the card pre-focuses the operator's last choice. */
  region?: KimiRegion
  lastRefreshMs?: number
  [k: string]: unknown
}

function authFilePath(): string {
  return join(getAuthConfigHomeDir(), AUTH_FILE_NAME)
}

function readAuthFile(): MoonshotAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as MoonshotAuthFile
  } catch {
    return null
  }
}

function writeAuthFile(mutate: (file: MoonshotAuthFile) => MoonshotAuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const existing = readAuthFile() ?? { version: MOONSHOT_AUTH_VERSION }
  const next = mutate({ ...existing, version: MOONSHOT_AUTH_VERSION })
  const path = authFilePath()
  // mode 600 at CREATION (the sibling auth stores' law): without it the
  // atomic temp file lands umask-default and the tokens sit group/world-
  // readable until the chmod below — and forever where chmod fails.
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best-effort on non-POSIX */
  }
}

/** Store tokens from a completed device flow (or clear with null — the
 *  region choice stays remembered). A region given with the tokens is
 *  recorded as the login's region. */
export function writeMoonshotTokens(tokens: MoonshotStoredTokens | null, region?: KimiRegion): void {
  writeAuthFile(file => {
    const next = { ...file }
    if (tokens === null) {
      delete next.tokens
      return next
    }
    next.tokens = tokens
    next.lastRefreshMs = Date.now()
    if (region !== undefined) next.region = region
    return next
  })
}

/** Remember the region the operator picked (the card writes it before the
 *  device flow starts, so an abandoned sign-in still keeps the choice). */
export function writeMoonshotRegion(region: KimiRegion): void {
  writeAuthFile(file => ({ ...file, region }))
}

export function moonshotStoredTokens(): MoonshotStoredTokens | undefined {
  const tokens = readAuthFile()?.tokens
  return tokens && typeof tokens.accessToken === 'string' && tokens.accessToken.trim() ? tokens : undefined
}

/** The remembered region, or undefined before any choice was made. */
export function moonshotStoredRegion(): KimiRegion | undefined {
  const region = readAuthFile()?.region
  return isKimiRegion(region) ? region : undefined
}

/** The region a stored login acts in. A login file that carries tokens but
 *  no region (a writer that stated none) acts on the global deployment —
 *  the card always states one, so this names the fallback rather than
 *  hiding it. */
export function moonshotLoginRegion(): KimiRegion {
  return moonshotStoredRegion() ?? 'global'
}

export function disconnectMoonshotOauth(): void {
  writeMoonshotTokens(null)
}

/** Diagnostic seam — the path only, never contents. */
export function moonshotAuthPathForDisplay(): string {
  return authFilePath()
}

// ── The device flow (RFC 8628; mechanism per the module header) ─────────────

export interface MoonshotDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSec: number
  expiresAtMs: number
  /** The region the flow runs in (the poll and the token store reuse it). */
  region: KimiRegion
}

export type MoonshotDevicePollResult =
  | { state: 'authorized'; tokens: MoonshotStoredTokens }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'denied'; code: string; description?: string }
  /** The host did not answer (transport fault) — the flow is NOT settled;
   *  the caller keeps polling until the code expires. */
  | { state: 'unreachable'; message: string }

export interface MoonshotOauthIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** The region to act in; absent ⇒ the stored login's region. */
  region?: KimiRegion
}

function oauthFetch(io?: MoonshotOauthIo): typeof fetch {
  return io?.fetchImpl ?? getApiFetch()
}

function ioRegion(io?: MoonshotOauthIo): KimiRegion {
  return io?.region ?? moonshotLoginRegion()
}

async function postForm(
  url: string,
  form: Record<string, string>,
  io?: MoonshotOauthIo,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = oauthFetch(io)
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  // The provider-call deadline law: each token/device poll ends within the bound.
  const response = await fetchWithProviderDeadline(fetchImpl, 'moonshot', LOGIN_EXCHANGE_TIMEOUT_MS, url, {
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

/** Begin the device flow in a region. Throws for a refused start — token
 *  VALUES never ride errors. */
export async function startMoonshotDeviceAuth(io?: MoonshotOauthIo): Promise<MoonshotDeviceAuthStart> {
  const env = io?.env ?? process.env
  const region = ioRegion(io)
  const { status, body } = await postForm(
    `${moonshotOauthBase(region, env)}${MOONSHOT_DEVICE_AUTH_PATH}`,
    { client_id: moonshotOauthClientId(env) },
    io,
  )
  const deviceCode = typeof body.device_code === 'string' ? body.device_code : undefined
  const userCode = typeof body.user_code === 'string' ? body.user_code : undefined
  const verificationUri =
    typeof body.verification_uri === 'string' ? body.verification_uri : undefined
  if (status !== 200 || !deviceCode || !userCode || !verificationUri) {
    const detail = typeof body.error === 'string' ? ` — ${body.error}` : ''
    throw new Error(`Kimi device authorization refused (HTTP ${status}${detail})`)
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
    region,
  }
}

function tokensFromBody(body: Record<string, unknown>, io?: MoonshotOauthIo): MoonshotStoredTokens | undefined {
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined
  if (!accessToken) return undefined
  const now = io?.now?.() ?? Date.now()
  return {
    accessToken,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === 'number'
      ? { accessTokenExpiresAtMs: now + body.expires_in * 1000 }
      : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  }
}

/** One token poll. The caller owns the interval loop (slow_down ⇒ +5s per
 *  RFC 8628 §3.5). Never throws: a transport fault is the typed
 *  'unreachable' (an un-caught rejection would kill the card's poll loop
 *  with the surface still painting "waiting"). */
export async function pollMoonshotDeviceToken(
  start: Pick<MoonshotDeviceAuthStart, 'deviceCode' | 'region'>,
  io?: MoonshotOauthIo,
): Promise<MoonshotDevicePollResult> {
  const env = io?.env ?? process.env
  let posted: { status: number; body: Record<string, unknown> }
  try {
    posted = await postForm(
      `${moonshotOauthBase(start.region, env)}${MOONSHOT_TOKEN_PATH}`,
      { client_id: moonshotOauthClientId(env), device_code: start.deviceCode, grant_type: DEVICE_GRANT },
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

let refreshInFlight: Promise<MoonshotStoredTokens | undefined> | null = null

/** Refresh stored tokens; returns the fresh set (persisted) or undefined
 *  (refresh refused ⇒ stored tokens dropped so state stays honest; a
 *  transport failure keeps them). Single-flight. */
export function refreshMoonshotTokens(io?: MoonshotOauthIo): Promise<MoonshotStoredTokens | undefined> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async (): Promise<MoonshotStoredTokens | undefined> => {
    try {
      const env = io?.env ?? process.env
      const stored = moonshotStoredTokens()
      if (!stored?.refreshToken) return undefined
      const region = ioRegion(io)
      let result: { status: number; body: Record<string, unknown> }
      try {
        result = await postForm(
          `${moonshotOauthBase(region, env)}${MOONSHOT_TOKEN_PATH}`,
          {
            client_id: moonshotOauthClientId(env),
            refresh_token: stored.refreshToken,
            grant_type: 'refresh_token',
          },
          io,
        )
      } catch {
        return undefined
      }
      const tokens = tokensFromBody(result.body, io)
      if (result.status === 200 && tokens) {
        const next = { ...tokens, refreshToken: tokens.refreshToken ?? stored.refreshToken }
        writeMoonshotTokens(next, region)
        return next
      }
      if (result.status === 400 || result.status === 401) writeMoonshotTokens(null)
      return undefined
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// ── Account resolution (never a secret in a record) ─────────────────────────

export type MoonshotAccountRef =
  | {
      kind: 'kimi-oauth'
      /** Display words only (sign-in + region facts, never a value). */
      label: string
      region: KimiRegion
    }
  | {
      kind: 'api-key'
      label: string
      keySource: 'env' | 'stored'
    }

/** The ONE Moonshot KEY resolution: env MOONSHOT_API_KEY WINS over the
 *  auth-scoped store. The VALUE never enters records, logs, or errors. */
export function resolveMoonshotApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.MOONSHOT_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredMoonshotApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

/** The resolved account for display/slots — the source a dispatch would
 *  bill, in precedence order env > Kimi sign-in > stored key. Sync, never
 *  network: an expiring sign-in is still reported here; the dispatch
 *  resolver refreshes it. */
export function resolveMoonshotAccount(
  env: NodeJS.ProcessEnv = process.env,
): MoonshotAccountRef | undefined {
  const envKey = env.MOONSHOT_API_KEY?.trim()
  if (envKey) return { kind: 'api-key', label: 'MOONSHOT_API_KEY (env)', keySource: 'env' }
  if (moonshotStoredTokens()) {
    const region = moonshotLoginRegion()
    return {
      kind: 'kimi-oauth',
      label: `Kimi account (device-code sign-in · ${kimiRegionLabel(region)})`,
      region,
    }
  }
  const stored = readStoredMoonshotApiKey()
  if (stored) {
    return { kind: 'api-key', label: 'Moonshot API key (stored, auth-scoped)', keySource: 'stored' }
  }
  return undefined
}

export type MoonshotDispatchSource = 'env' | 'kimi-oauth' | 'stored'

/** The source a dispatch WOULD bill right now (presence, sync, no refresh)
 *  — readiness and validation read this; the wire reads the async resolver. */
export function moonshotDispatchSource(env: NodeJS.ProcessEnv = process.env): MoonshotDispatchSource | undefined {
  const account = resolveMoonshotAccount(env)
  if (!account) return undefined
  return account.kind === 'kimi-oauth' ? 'kimi-oauth' : account.keySource
}

export interface MoonshotDispatchCredential {
  apiKey: string
  /** The chat-completions URL this credential is valid for: the region's
   *  coding base for a Kimi sign-in, the platform base for a key. */
  requestUrl: string
  source: MoonshotDispatchSource
}

/** The DISPATCH credential: env key > the Kimi sign-in (refreshed when
 *  under the margin, dropped when expired with no refresh route) > stored
 *  key — each with the base it is valid on. Async because the refresh is a
 *  network act; undefined = the honest refusal. ONE truth with the display
 *  resolver: while the sign-in tokens stay on disk (the reported source),
 *  an unusable bearer REFUSES — it never silently falls through to the
 *  stored key the surfaces do not name (the wire must bill the credential
 *  the surfaces report). */
export async function resolveMoonshotDispatchCredential(
  io?: MoonshotOauthIo,
): Promise<MoonshotDispatchCredential | undefined> {
  const env = io?.env ?? process.env
  const envKey = env.MOONSHOT_API_KEY?.trim()
  if (envKey) return { apiKey: envKey, requestUrl: moonshotChatCompletionsUrl(env), source: 'env' }
  const oauth = moonshotStoredTokens()
  if (oauth) {
    const region = ioRegion(io)
    const requestUrl = kimiCodingChatCompletionsUrl(region, env)
    const now = io?.now?.() ?? Date.now()
    const expiresAt = oauth.accessTokenExpiresAtMs
    if (expiresAt !== undefined && expiresAt - now < REFRESH_MARGIN_MS) {
      if (oauth.refreshToken) {
        const fresh = await refreshMoonshotTokens(io)
        if (fresh) return { apiKey: fresh.accessToken, requestUrl, source: 'kimi-oauth' }
        // A refused refresh dropped the tokens — the store changed, every
        // surface now reports the next source, so falling through is
        // honest. A transport failure KEPT them: an unexpired token still
        // dispatches; an expired one refuses outright, because the kept
        // sign-in is still what every surface reports.
        const remaining = moonshotStoredTokens()
        if (remaining) {
          if (remaining.accessTokenExpiresAtMs === undefined || remaining.accessTokenExpiresAtMs > now) {
            return { apiKey: remaining.accessToken, requestUrl, source: 'kimi-oauth' }
          }
          return undefined
        }
      } else if (expiresAt <= now) {
        writeMoonshotTokens(null)
      } else {
        return { apiKey: oauth.accessToken, requestUrl, source: 'kimi-oauth' }
      }
    } else {
      return { apiKey: oauth.accessToken, requestUrl, source: 'kimi-oauth' }
    }
  }
  const stored = readStoredMoonshotApiKey()
  return stored ? { apiKey: stored, requestUrl: moonshotChatCompletionsUrl(env), source: 'stored' } : undefined
}

/** Proof seam. */
export function __resetMoonshotAccountsForTest(): void {
  refreshInFlight = null
}
