import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { readStoredHuggingfaceApiKey } from '../../../utils/router/providerSecrets.js'
import { noteCredentialChange } from '../../../utils/accounts/signInLedger.js'


const HF_HUB_BASE_URL = 'https://huggingface.co'
const HF_ROUTER_BASE_URL = 'https://router.huggingface.co/v1'
const HF_OAUTH_DEVICE_PATH = '/oauth/device'
const HF_OAUTH_TOKEN_PATH = '/oauth/token'
const HF_OAUTH_REGISTER_PATH = '/oauth/register'
const HF_WHOAMI_PATH = '/api/whoami-v2'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export const HF_OAUTH_SCOPE = 'openid profile inference-api'
const HF_CLIENT_NAME = 'Mercury'
const DEVICE_DEFAULT_INTERVAL_SEC = 5
const REFRESH_MARGIN_MS = 15 * 60 * 1000
const WHOAMI_TIMEOUT_MS = 10_000

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
export function huggingfaceOauthClientIdPin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID']?.trim() || undefined
}
export function huggingfaceBillTo(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['MERCURY_HUGGINGFACE_BILL_TO']?.trim() || undefined
}


const HF_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.huggingface-auth.json'

export interface HuggingfaceStoredTokens {
  accessToken: string
  refreshToken?: string
  accessTokenExpiresAtMs?: number
  scope?: string
}

export interface HuggingfaceIdentity {
  username: string
  fullName?: string
  observedAtMs: number
}

interface HuggingfaceAuthFile {
  version: number
  tokens?: HuggingfaceStoredTokens
  identity?: HuggingfaceIdentity
  tokenIdentity?: HuggingfaceIdentity & { keyTail: string }
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
  }
  noteCredentialChange()
}

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

export function huggingfaceKeyTail(key: string | undefined): string {
  const trimmed = key?.trim() ?? ''
  return trimmed.length >= 10 ? trimmed.slice(-4) : ''
}

export function writeHuggingfaceTokenIdentity(key: string, identity: HuggingfaceIdentity | null): void {
  const keyTail = huggingfaceKeyTail(key)
  writeAuthFile(file => {
    const next = { ...file }
    if (identity === null) delete next.tokenIdentity
    else next.tokenIdentity = { ...identity, keyTail }
    return next
  })
}

export function huggingfaceStoredTokenIdentity(key: string | undefined): HuggingfaceIdentity | undefined {
  const stored = readAuthFile()?.tokenIdentity
  if (!stored || !key) return undefined
  return stored.keyTail === huggingfaceKeyTail(key) ? stored : undefined
}


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
  }
  return { status: response.status, body }
}

export function huggingfaceRegisteredClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stored = readAuthFile()?.registeredClient
  if (!stored || typeof stored.clientId !== 'string' || !stored.clientId) return undefined
  return stored.hubBase === huggingfaceHubBase(env) ? stored.clientId : undefined
}

export async function registerHuggingfaceOauthClient(io?: HuggingfaceOauthIo): Promise<string> {
  const env = io?.env ?? process.env
  const url = `${huggingfaceHubBase(env)}${HF_OAUTH_REGISTER_PATH}`
  const fetchImpl = oauthFetch(io)
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  let response: Response
  try {
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

export async function resolveHuggingfaceOauthClientId(io?: HuggingfaceOauthIo): Promise<string> {
  const env = io?.env ?? process.env
  const pinned = huggingfaceOauthClientIdPin(env)
  if (pinned) return pinned
  const stored = huggingfaceRegisteredClientId(env)
  if (stored) return stored
  return registerHuggingfaceOauthClient(io)
}


export interface HuggingfaceDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSec: number
  expiresAtMs: number
  clientId: string
}

export type HuggingfaceDevicePollResult =
  | { state: 'authorized'; tokens: HuggingfaceStoredTokens }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'denied'; code: string; description?: string }
  | { state: 'unreachable'; message: string }

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


export type HuggingfaceIdentityProbe =
  | { state: 'confirmed'; identity: HuggingfaceIdentity }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

export async function fetchHuggingfaceIdentity(
  token: string,
  io?: HuggingfaceOauthIo,
): Promise<HuggingfaceIdentityProbe> {
  const env = io?.env ?? process.env
  const fetchImpl = oauthFetch(io)
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  try {
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


export type HuggingfaceKeySource = 'env' | 'oauth' | 'stored'

export interface HuggingfaceAccountRef {
  kind: 'oauth' | 'api-key'
  label: string
  keySource: HuggingfaceKeySource
  username?: string
}

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

export function huggingfaceKeySource(
  env: Record<string, string | undefined> = process.env,
): HuggingfaceKeySource | undefined {
  return resolveHuggingfaceApiKey(env)?.source
}

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

export function huggingfaceAuthPathForDisplay(): string {
  return authFilePath()
}

export function __resetHuggingfaceAccountsForTest(): void {
  refreshInFlight = null
}
