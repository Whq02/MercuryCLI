//       global — https://auth.kimi.ai + https://api.kimi.ai/coding/v1;
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { readStoredMoonshotApiKey } from '../../../utils/router/providerSecrets.js'
import { noteCredentialChange } from '../../../utils/accounts/signInLedger.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { credentialFingerprint } from '../credentialIdentity.js'


const MOONSHOT_API_BASE_URL = 'https://api.moonshot.ai/v1'
const MOONSHOT_DEVICE_AUTH_PATH = '/api/oauth/device_authorization'
const MOONSHOT_TOKEN_PATH = '/api/oauth/token'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const LOGIN_EXCHANGE_TIMEOUT_MS = 15_000

export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const DEVICE_DEFAULT_INTERVAL_SEC = 5
const REFRESH_MARGIN_MS = 15 * 60 * 1000

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

export function kimiRegionLabel(region: KimiRegion): string {
  return KIMI_REGION_PROFILES[region].label
}

export function moonshotApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_MOONSHOT_API_BASE']?.trim() || MOONSHOT_API_BASE_URL).replace(/\/+$/, '')
}
export function moonshotChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${moonshotApiBase(env)}/chat/completions`
}
export function moonshotOauthBase(region: KimiRegion, env: NodeJS.ProcessEnv = process.env): string {
  return (env['MERCURY_MOONSHOT_OAUTH_BASE']?.trim() || KIMI_REGION_PROFILES[region].oauthHost).replace(
    /\/+$/,
    '',
  )
}
export function moonshotOauthClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_MOONSHOT_OAUTH_CLIENT_ID']?.trim() || KIMI_OAUTH_CLIENT_ID
}
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


const MOONSHOT_AUTH_VERSION = 1
const AUTH_FILE_NAME = '.moonshot-auth.json'

export interface MoonshotStoredTokens {
  accessToken: string
  refreshToken?: string
  accessTokenExpiresAtMs?: number
  scope?: string
}

export interface MoonshotServedModelRecord {
  requested: string
  served: string
  observedAtMs: number
}

interface MoonshotAuthFile {
  version: number
  tokens?: MoonshotStoredTokens
  region?: KimiRegion
  lastRefreshMs?: number
  servedModels?: Record<string, MoonshotServedModelRecord[]>
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

function publishAuthFile(mutate: (file: MoonshotAuthFile) => MoonshotAuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const existing = readAuthFile() ?? { version: MOONSHOT_AUTH_VERSION }
  const next = mutate({ ...existing, version: MOONSHOT_AUTH_VERSION })
  const path = authFilePath()
  durableAtomicPublishSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
  }
}

function writeAuthFile(mutate: (file: MoonshotAuthFile) => MoonshotAuthFile): void {
  publishAuthFile(mutate)
  noteCredentialChange()
}

const SERVED_MODELS_PER_ACCOUNT = 16
const SERVED_MODEL_ACCOUNTS = 8

function isServedModelRecord(value: unknown): value is MoonshotServedModelRecord {
  const record = value as Partial<MoonshotServedModelRecord> | null
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.requested === 'string' &&
    record.requested !== '' &&
    typeof record.served === 'string' &&
    record.served !== '' &&
    typeof record.observedAtMs === 'number' &&
    Number.isFinite(record.observedAtMs)
  )
}

function servedModelTableOf(file: MoonshotAuthFile | null): Record<string, MoonshotServedModelRecord[]> {
  const table: Record<string, MoonshotServedModelRecord[]> = {}
  const raw = file?.servedModels
  if (typeof raw !== 'object' || raw === null) return table
  for (const [identity, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    const kept = rows.filter(isServedModelRecord)
    if (kept.length > 0) table[identity] = kept
  }
  return table
}

function tokenIdentity(tokens: MoonshotStoredTokens): string {
  return credentialFingerprint(tokens.refreshToken ?? tokens.accessToken)
}

export function moonshotAccountIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envKey = env.MOONSHOT_API_KEY?.trim()
  if (envKey) return credentialFingerprint(envKey)
  const tokens = moonshotStoredTokens()
  if (tokens) return tokenIdentity(tokens)
  const stored = readStoredMoonshotApiKey()
  return stored ? credentialFingerprint(stored) : undefined
}

function withServedModelTable(file: MoonshotAuthFile, table: Record<string, MoonshotServedModelRecord[]>): MoonshotAuthFile {
  const next = { ...file }
  if (Object.keys(table).length > 0) next.servedModels = table
  else delete next.servedModels
  return next
}

function withServedModelsMoved(file: MoonshotAuthFile, from: string, to: string): MoonshotAuthFile {
  if (from === to) return file
  const table = servedModelTableOf(file)
  const rows = table[from]
  if (rows === undefined) return file
  delete table[from]
  table[to] = rows
  return withServedModelTable(file, table)
}

export function moonshotServedModels(env: NodeJS.ProcessEnv = process.env): MoonshotServedModelRecord[] {
  const identity = moonshotAccountIdentity(env)
  if (identity === undefined) return []
  return servedModelTableOf(readAuthFile())[identity] ?? []
}

export function moonshotServedModelFor(requested: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const wanted = requested.trim().toLowerCase()
  return moonshotServedModels(env).find(record => record.requested === wanted)?.served
}

export function moonshotAliasesServing(served: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const wanted = served.trim().toLowerCase()
  return moonshotServedModels(env)
    .filter(record => record.served === wanted)
    .map(record => record.requested)
}

export function recordMoonshotServedModel(
  requested: string,
  served: string,
  io?: { env?: NodeJS.ProcessEnv; now?: () => number; identity?: string },
): boolean {
  const asked = requested.trim().toLowerCase()
  const answered = served.trim().toLowerCase()
  if (asked === '' || answered === '') return false
  const identity = io?.identity ?? moonshotAccountIdentity(io?.env ?? process.env)
  if (identity === undefined || identity === '' || identity === 'none') return false
  try {
    const current = servedModelTableOf(readAuthFile())[identity] ?? []
    const previous = current.find(record => record.requested === asked)
    if (asked === answered ? previous === undefined : previous?.served === answered) return false
    const rows = current.filter(record => record.requested !== asked)
    if (asked !== answered) rows.push({ requested: asked, served: answered, observedAtMs: (io?.now ?? Date.now)() })
    while (rows.length > SERVED_MODELS_PER_ACCOUNT) rows.shift()
    publishAuthFile(file => {
      const table = servedModelTableOf(file)
      delete table[identity]
      const newest = (entries: MoonshotServedModelRecord[]): number => Math.max(...entries.map(record => record.observedAtMs))
      while (Object.keys(table).length >= SERVED_MODEL_ACCOUNTS) {
        const oldest = Object.entries(table).sort((a, b) => newest(a[1]) - newest(b[1]))[0]
        if (oldest === undefined) break
        delete table[oldest[0]]
      }
      if (rows.length > 0) table[identity] = rows
      return withServedModelTable(file, table)
    })
    bumpCatalogueEpoch()
    return true
  } catch {
    return false
  }
}

function withTokens(file: MoonshotAuthFile, tokens: MoonshotStoredTokens | null, region?: KimiRegion): MoonshotAuthFile {
  const next = { ...file }
  if (tokens === null) {
    delete next.tokens
    return next
  }
  next.tokens = tokens
  next.lastRefreshMs = Date.now()
  if (region !== undefined) next.region = region
  return next
}

export function writeMoonshotTokens(tokens: MoonshotStoredTokens | null, region?: KimiRegion): void {
  writeAuthFile(file => withTokens(file, tokens, region))
}

export function writeMoonshotRegion(region: KimiRegion): void {
  writeAuthFile(file => ({ ...file, region }))
}

export function moonshotStoredTokens(): MoonshotStoredTokens | undefined {
  const tokens = readAuthFile()?.tokens
  return tokens && typeof tokens.accessToken === 'string' && tokens.accessToken.trim() ? tokens : undefined
}

export function moonshotStoredRegion(): KimiRegion | undefined {
  const region = readAuthFile()?.region
  return isKimiRegion(region) ? region : undefined
}

export function moonshotLoginRegion(): KimiRegion {
  return moonshotStoredRegion() ?? 'global'
}

export function disconnectMoonshotOauth(): void {
  writeMoonshotTokens(null)
}

export function moonshotAuthPathForDisplay(): string {
  return authFilePath()
}


export interface MoonshotDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSec: number
  expiresAtMs: number
  region: KimiRegion
}

export type MoonshotDevicePollResult =
  | { state: 'authorized'; tokens: MoonshotStoredTokens }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'denied'; code: string; description?: string }
  | { state: 'unreachable'; message: string }

export interface MoonshotOauthIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
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
  }
  return { status: response.status, body }
}

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
        writeAuthFile(file => withServedModelsMoved(withTokens(file, next, region), tokenIdentity(stored), tokenIdentity(next)))
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


export type MoonshotAccountRef =
  | {
      kind: 'kimi-oauth'
      label: string
      region: KimiRegion
    }
  | {
      kind: 'api-key'
      label: string
      keySource: 'env' | 'stored'
    }

export function resolveMoonshotApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.MOONSHOT_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredMoonshotApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

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

export function moonshotDispatchSource(env: NodeJS.ProcessEnv = process.env): MoonshotDispatchSource | undefined {
  const account = resolveMoonshotAccount(env)
  if (!account) return undefined
  return account.kind === 'kimi-oauth' ? 'kimi-oauth' : account.keySource
}

export interface MoonshotDispatchCredential {
  apiKey: string
  requestUrl: string
  source: MoonshotDispatchSource
  accountIdentity: string
}

export async function resolveMoonshotDispatchCredential(
  io?: MoonshotOauthIo,
): Promise<MoonshotDispatchCredential | undefined> {
  const env = io?.env ?? process.env
  const envKey = env.MOONSHOT_API_KEY?.trim()
  if (envKey) return { apiKey: envKey, requestUrl: moonshotChatCompletionsUrl(env), source: 'env', accountIdentity: credentialFingerprint(envKey) }
  const oauth = moonshotStoredTokens()
  if (oauth) {
    const region = ioRegion(io)
    const requestUrl = kimiCodingChatCompletionsUrl(region, env)
    const signedIn = (tokens: MoonshotStoredTokens): MoonshotDispatchCredential => ({ apiKey: tokens.accessToken, requestUrl, source: 'kimi-oauth', accountIdentity: tokenIdentity(tokens) })
    const now = io?.now?.() ?? Date.now()
    const expiresAt = oauth.accessTokenExpiresAtMs
    if (expiresAt !== undefined && expiresAt - now < REFRESH_MARGIN_MS) {
      if (oauth.refreshToken) {
        const fresh = await refreshMoonshotTokens(io)
        if (fresh) return signedIn(fresh)
        const remaining = moonshotStoredTokens()
        if (remaining) {
          if (remaining.accessTokenExpiresAtMs === undefined || remaining.accessTokenExpiresAtMs > now) {
            return signedIn(remaining)
          }
          return undefined
        }
      } else if (expiresAt <= now) {
        writeMoonshotTokens(null)
      } else {
        return signedIn(oauth)
      }
    } else {
      return signedIn(oauth)
    }
  }
  const stored = readStoredMoonshotApiKey()
  return stored ? { apiKey: stored, requestUrl: moonshotChatCompletionsUrl(env), source: 'stored', accountIdentity: credentialFingerprint(stored) } : undefined
}

export function __resetMoonshotAccountsForTest(): void {
  refreshInFlight = null
}
