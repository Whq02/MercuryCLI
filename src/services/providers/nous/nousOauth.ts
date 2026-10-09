import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { durableAtomicPublishSync } from '../../../substrate/durablePublish.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { lock } from '../../../utils/lockfile.js'
import { noteCredentialChange } from '../../../utils/accounts/signInLedger.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { presentedNousClient } from './nousClientContract.js'

export const NOUS_DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const NOUS_REFRESH_TOKEN_HEADER = 'x-nous-refresh-token'
export const NOUS_SIGNIN_EXPIRED_LINE = 'Nous Portal sign-in expired — sign in again (/logins nous) or use an API key'
export const NOUS_GRANT_DEAD_CODES = new Set(['invalid_grant', 'invalid_token', 'refresh_token_reused'])
const REFRESH_SKEW_MS = 120_000
const EXCHANGE_DEADLINE_MS = 15_000

export interface NousTokens {
  accessToken: string
  refreshToken: string
  expiresAtMs?: number
  scope?: string
  inferenceBase?: string
  accountId?: string
}

export interface NousSigninRefusal {
  fingerprint: string
  status: number
  code: string
  message: string
  observedAtMs: number
}

export type NousPreferredSource = 'signin' | 'api-key'

interface AuthFile {
  version: number
  tokens?: NousTokens
  preferredSource?: NousPreferredSource
  refused?: unknown
  [key: string]: unknown
}

export interface NousOauthIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
}

export function nousAuthPathForDisplay(): string {
  return join(getAuthConfigHomeDir(), '.nous-auth.json')
}

function readAuth(): AuthFile {
  try {
    const value = JSON.parse(readFileSync(nousAuthPathForDisplay(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { version: 1 }
  } catch {
    return { version: 1 }
  }
}

function writeAuth(file: AuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  durableAtomicPublishSync(nousAuthPathForDisplay(), JSON.stringify({ ...file, version: 1 }) + '\n', { mode: 0o600 })
  noteCredentialChange()
}

function tokensOf(file: AuthFile): NousTokens | undefined {
  const tokens = file.tokens
  return tokens && typeof tokens.accessToken === 'string' && tokens.accessToken.length > 0 && typeof tokens.refreshToken === 'string' ? tokens : undefined
}

export function nousStoredTokens(): NousTokens | undefined {
  return tokensOf(readAuth())
}

export function writeNousTokens(tokens: NousTokens | null): void {
  const file = readAuth()
  if (tokens) {
    file.tokens = tokens
    delete file.refused
  } else {
    delete file.tokens
    delete file.refused
  }
  writeAuth(file)
}

export function clearStoredNousSignin(): void {
  writeNousTokens(null)
}

export function readPreferredNousSource(): NousPreferredSource | undefined {
  const value = readAuth().preferredSource
  return value === 'signin' || value === 'api-key' ? value : undefined
}

export function writePreferredNousSource(source: NousPreferredSource): void {
  writeAuth({ ...readAuth(), preferredSource: source })
}

function refusalOf(file: AuthFile): NousSigninRefusal | undefined {
  const raw = file.refused
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.fingerprint !== 'string' || typeof r.status !== 'number' || typeof r.message !== 'string' || typeof r.code !== 'string') return undefined
  return { fingerprint: r.fingerprint, status: r.status, code: r.code, message: r.message, observedAtMs: typeof r.observedAtMs === 'number' ? r.observedAtMs : 0 }
}

export function nousSigninRefusal(): NousSigninRefusal | undefined {
  const file = readAuth()
  const refusal = refusalOf(file)
  const tokens = tokensOf(file)
  if (refusal === undefined || tokens === undefined) return undefined
  return refusal.fingerprint === credentialFingerprint(tokens.accessToken) ? refusal : undefined
}

export function nousSigninRefusalNote(refusal: Pick<NousSigninRefusal, 'status' | 'code' | 'message'>): string {
  return `${NOUS_SIGNIN_EXPIRED_LINE} — the Portal answered HTTP ${refusal.status} (${refusal.code}${refusal.message ? `: ${refusal.message}` : ''})`
}

export function markNousSigninRefused(tokens: NousTokens, status: number, code: string, message: string, now: () => number = Date.now): void {
  const file = readAuth()
  const stored = tokensOf(file)
  if (stored === undefined || stored.accessToken !== tokens.accessToken) return
  file.tokens = { ...stored, refreshToken: '' }
  file.refused = { fingerprint: credentialFingerprint(stored.accessToken), status, code, message: message.trim().slice(0, 256) || `HTTP ${status}`, observedAtMs: now() } satisfies NousSigninRefusal
  writeAuth(file)
}

function jwt(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1]
    if (!part) return {}
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function trustedInferenceBase(value: unknown, io?: NousOauthIo): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return undefined
    const fixture = (io?.env ?? process.env)['MERCURY_NOUS_API_BASE']?.trim()
    const loopback = fixture ? new URL(fixture) : undefined
    const sameBox = loopback !== undefined && ['127.0.0.1', 'localhost', '[::1]'].includes(loopback.hostname) && url.origin === loopback.origin
    if (!sameBox && !(url.protocol === 'https:' && (url.hostname === 'nousresearch.com' || url.hostname.endsWith('.nousresearch.com')))) return undefined
    return value.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

export function tokensFromNousBody(body: Record<string, unknown>, io?: NousOauthIo, old?: NousTokens): NousTokens {
  if (typeof body.access_token !== 'string' || !body.access_token.trim()) throw new Error('the Portal returned no access token')
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.trim() ? body.refresh_token : old?.refreshToken
  if (!refreshToken) throw new Error('the Portal returned no refresh token')
  const claims = jwt(body.access_token)
  const now = io?.now?.() ?? Date.now()
  const expiresAtMs = positive(body.expires_in) ? now + body.expires_in * 1000 : positive(claims.exp) ? claims.exp * 1000 : undefined
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : old?.scope
  const inferenceBase = trustedInferenceBase(body.inference_base_url, io) ?? old?.inferenceBase
  const accountId = typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length < 256 ? claims.sub : old?.accountId
  return {
    accessToken: body.access_token,
    refreshToken,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(inferenceBase !== undefined ? { inferenceBase } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
  }
}

function portalBase(env: NodeJS.ProcessEnv | undefined): string {
  return ((env ?? process.env)['MERCURY_NOUS_PORTAL_BASE']?.trim() || 'https://portal.nousresearch.com').replace(/\/+$/, '')
}

export interface NousPortalAnswer {
  status: number
  body: Record<string, unknown>
  edge?: string
}

async function post(path: string, form: Record<string, string>, io: NousOauthIo | undefined, headers: Record<string, string> = {}): Promise<NousPortalAnswer> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(io?.fetchImpl ?? getApiFetch(), 'nous', EXCHANGE_DEADLINE_MS, `${portalBase(io?.env)}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': getUserAgent(), ...headers },
      body: new URLSearchParams(form).toString(),
      ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch {
    throw new Error('the Nous Portal did not answer')
  }
  const edge = response.headers.get('x-vercel-mitigated') ?? undefined
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return { status: response.status, body, ...(edge !== undefined ? { edge } : {}) }
}

function described(body: Record<string, unknown>): string {
  return typeof body.error_description === 'string' && body.error_description.trim() ? body.error_description.trim() : typeof body.message === 'string' && body.message.trim() ? body.message.trim() : ''
}

function withoutClientId(words: string, clientId: string): string {
  return words.split(clientId).join('').replace(/:\s*$/, '').replace(/\s{2,}/g, ' ').trim()
}

export interface NousDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAtMs: number
  intervalSec: number
  clientId: string
}

function verificationUrl(value: unknown, io?: NousOauthIo): string {
  if (typeof value !== 'string') throw new Error('the Portal returned no verification URL')
  const url = new URL(value)
  const fixture = new URL(portalBase(io?.env))
  const trusted = (url.protocol === 'https:' && (url.hostname === 'nousresearch.com' || url.hostname.endsWith('.nousresearch.com'))) || (['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) && url.origin === fixture.origin)
  if (url.username || url.password || !trusted) throw new Error('the Portal returned an untrusted verification URL')
  return value
}

export async function startNousDeviceAuth(io?: NousOauthIo): Promise<NousDeviceAuthStart> {
  const client = presentedNousClient()
  const result = await post('/api/oauth/device/code', { client_id: client.clientId, scope: client.scope }, io)
  if (result.status !== 200) {
    const words = withoutClientId(described(result.body), client.clientId)
    throw new Error(`the Portal refused the sign-in request (HTTP ${result.status}${words ? `: ${words}` : ''})`)
  }
  const b = result.body
  if (typeof b.device_code !== 'string' || !b.device_code || typeof b.user_code !== 'string' || !b.user_code) throw new Error('the Portal returned an incomplete device code')
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: verificationUrl(b.verification_uri, io),
    ...(typeof b.verification_uri_complete === 'string' && b.verification_uri_complete ? { verificationUriComplete: verificationUrl(b.verification_uri_complete, io) } : {}),
    expiresAtMs: (io?.now?.() ?? Date.now()) + (positive(b.expires_in) ? b.expires_in : 300) * 1000,
    intervalSec: Math.max(1, positive(b.interval) ? b.interval : 5),
    clientId: client.clientId,
  }
}

export type NousDevicePoll =
  | { state: 'authorized'; tokens: NousTokens }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'unavailable' }
  | { state: 'denied'; words: string }
  | { state: 'expired'; words: string }
  | { state: 'refused'; words: string }

export async function pollNousDeviceToken(start: NousDeviceAuthStart, io?: NousOauthIo): Promise<NousDevicePoll> {
  const result = await post('/api/oauth/token', { grant_type: NOUS_DEVICE_CODE_GRANT, client_id: start.clientId, device_code: start.deviceCode }, io)
  if (result.status === 200) {
    try {
      return { state: 'authorized', tokens: tokensFromNousBody(result.body, io) }
    } catch (error) {
      return { state: 'refused', words: error instanceof Error ? error.message : String(error) }
    }
  }
  const code = typeof result.body.error === 'string' ? result.body.error : ''
  if (!code && (result.status === 408 || result.status === 429 || result.status >= 500 || (result.status === 403 && result.edge !== undefined))) return { state: 'unavailable' }
  const words = described(result.body) || `HTTP ${result.status}${code ? ` (${code})` : ''}`
  switch (code) {
    case 'authorization_pending':
      return { state: 'pending' }
    case 'slow_down':
      return { state: 'slow-down' }
    case 'access_denied':
    case 'authorization_declined':
      return { state: 'denied', words }
    case 'expired_token':
      return { state: 'expired', words }
    default:
      return { state: 'refused', words }
  }
}

export class NousRefreshRefusedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'NousRefreshRefusedError'
  }
}

function fresh(tokens: NousTokens | undefined, now: number): tokens is NousTokens {
  return tokens !== undefined && tokens.refreshToken.length > 0 && tokens.expiresAtMs !== undefined && tokens.expiresAtMs > now + REFRESH_SKEW_MS
}

const refreshes = new Map<string, Promise<NousTokens | undefined>>()
let refreshTrouble: string | undefined

export function nousRefreshTrouble(): string | undefined {
  return refreshTrouble
}

export function refreshNousTokens(io?: NousOauthIo, force = false): Promise<NousTokens | undefined> {
  const path = nousAuthPathForDisplay()
  const existing = refreshes.get(path)
  if (existing) return existing
  const now = io?.now ?? Date.now
  const before = nousStoredTokens()
  if (!before?.refreshToken) return Promise.resolve(undefined)
  if (!force && fresh(before, now())) return Promise.resolve(before)
  const work = (async (): Promise<NousTokens | undefined> => {
    mkdirSync(getAuthConfigHomeDir(), { recursive: true })
    let release: () => Promise<void>
    try {
      release = await lock(path, { realpath: false, stale: 20_000, retries: { retries: 12, factor: 1.4, minTimeout: 150, maxTimeout: 1_200 } })
    } catch {
      const latest = nousStoredTokens()
      if (latest?.refreshToken && (latest.refreshToken !== before.refreshToken || fresh(latest, now()))) return latest
      refreshTrouble = 'another Mercury is refreshing the Nous Portal sign-in — the stored sign-in is kept'
      throw new Error(`${refreshTrouble}; retry in a moment`)
    }
    try {
      if (nousAuthPathForDisplay() !== path) return undefined
      const old = nousStoredTokens()
      if (!old?.refreshToken) return undefined
      if (old.refreshToken !== before.refreshToken) return old
      if (!force && fresh(old, now())) return old
      const client = presentedNousClient()
      const result = await post('/api/oauth/token', { grant_type: 'refresh_token', client_id: client.clientId }, io, { [NOUS_REFRESH_TOKEN_HEADER]: old.refreshToken })
      const current = nousStoredTokens()
      if (nousAuthPathForDisplay() !== path || current?.refreshToken !== old.refreshToken) return current?.refreshToken ? current : undefined
      if (result.status === 200) {
        const tokens = tokensFromNousBody(result.body, io, old)
        writeNousTokens(tokens)
        refreshTrouble = undefined
        return tokens
      }
      const code = typeof result.body.error === 'string' ? result.body.error : ''
      const words = described(result.body)
      const dead = NOUS_GRANT_DEAD_CODES.has(code) || /reuse/i.test(words) || (!code && (result.status === 401 || result.status === 403) && result.edge === undefined)
      if (dead) {
        const verdict = code || 'invalid_grant'
        refreshTrouble = undefined
        markNousSigninRefused(old, result.status, verdict, words, now)
        throw new NousRefreshRefusedError(nousSigninRefusalNote({ status: result.status, code: verdict, message: words }), result.status, verdict)
      }
      refreshTrouble = `the Nous Portal could not refresh the sign-in (HTTP ${result.status}${words ? `: ${words}` : ''}) — the stored sign-in is kept`
      throw new Error(`${refreshTrouble}; retry shortly`)
    } finally {
      await release().catch(() => undefined)
    }
  })().finally(() => refreshes.delete(path))
  refreshes.set(path, work)
  return work
}
