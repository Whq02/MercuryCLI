import { createHash, randomBytes, randomUUID } from 'node:crypto'
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

export const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
export const QWEN_OAUTH_SCOPE = 'openid profile email model.completion'
export const QWEN_OAUTH_CLIENT_SOURCE = 'github.com/QwenLM/qwen-code packages/core/src/qwen/qwenOAuth2.ts, read 2026-10-18'
export const QWEN_DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const QWEN_SIGNIN_EXPIRED_LINE = 'Qwen account sign-in expired — sign in again (/logins qwen) or use a Model Studio API key'
export const QWEN_PLAN_DEFAULT_RESOURCE = 'portal.qwen.ai'
const QWEN_PORTAL_BASE_URL = 'https://chat.qwen.ai'
const QWEN_PORTAL_SEAM_ENV = 'MERCURY_QWEN_PORTAL_BASE'
const DEVICE_CODE_PATH = '/api/v1/oauth2/device/code'
const TOKEN_PATH = '/api/v1/oauth2/token'
const REFRESH_SKEW_MS = 120_000
const EXCHANGE_DEADLINE_MS = 15_000
const DEFAULT_POLL_SEC = 2
const DEFAULT_EXPIRES_SEC = 300

export interface QwenTokens {
  accessToken: string
  refreshToken: string
  expiresAtMs?: number
  scope?: string
  resourceUrl?: string
}

export interface QwenSigninRefusal {
  fingerprint: string
  status: number
  code: string
  message: string
  observedAtMs: number
}

export type QwenPreferredSource = 'signin' | 'api-key'

interface AuthFile {
  version: number
  tokens?: QwenTokens
  preferredSource?: QwenPreferredSource
  refused?: unknown
  [key: string]: unknown
}

export interface QwenOauthIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
}

export function qwenAuthPathForDisplay(): string {
  return join(getAuthConfigHomeDir(), '.qwen-auth.json')
}

function readAuth(): AuthFile {
  try {
    const value = JSON.parse(readFileSync(qwenAuthPathForDisplay(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { version: 1 }
  } catch {
    return { version: 1 }
  }
}

function writeAuth(file: AuthFile): void {
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  durableAtomicPublishSync(qwenAuthPathForDisplay(), JSON.stringify({ ...file, version: 1 }) + '\n', { mode: 0o600 })
  noteCredentialChange()
}

function tokensOf(file: AuthFile): QwenTokens | undefined {
  const tokens = file.tokens
  return tokens && typeof tokens.accessToken === 'string' && tokens.accessToken.length > 0 && typeof tokens.refreshToken === 'string' ? tokens : undefined
}

export function qwenStoredTokens(): QwenTokens | undefined {
  return tokensOf(readAuth())
}

export function writeQwenTokens(tokens: QwenTokens | null): void {
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

export function clearStoredQwenSignin(): void {
  writeQwenTokens(null)
}

export function readPreferredQwenSource(): QwenPreferredSource | undefined {
  const value = readAuth().preferredSource
  return value === 'signin' || value === 'api-key' ? value : undefined
}

export function writePreferredQwenSource(source: QwenPreferredSource): void {
  writeAuth({ ...readAuth(), preferredSource: source })
}

function refusalOf(file: AuthFile): QwenSigninRefusal | undefined {
  const raw = file.refused
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.fingerprint !== 'string' || typeof r.status !== 'number' || typeof r.message !== 'string' || typeof r.code !== 'string') return undefined
  return { fingerprint: r.fingerprint, status: r.status, code: r.code, message: r.message, observedAtMs: typeof r.observedAtMs === 'number' ? r.observedAtMs : 0 }
}

export function qwenSigninRefusal(): QwenSigninRefusal | undefined {
  const file = readAuth()
  const refusal = refusalOf(file)
  const tokens = tokensOf(file)
  if (refusal === undefined || tokens === undefined) return undefined
  return refusal.fingerprint === credentialFingerprint(tokens.accessToken) ? refusal : undefined
}

export function qwenSigninRefusalNote(refusal: Pick<QwenSigninRefusal, 'status' | 'code' | 'message'>): string {
  return `${QWEN_SIGNIN_EXPIRED_LINE} — the sign-in service answered HTTP ${refusal.status} (${refusal.code}${refusal.message ? `: ${refusal.message}` : ''})`
}

export function markQwenSigninRefused(tokens: QwenTokens, status: number, code: string, message: string, now: () => number = Date.now): void {
  const file = readAuth()
  const stored = tokensOf(file)
  if (stored === undefined || stored.accessToken !== tokens.accessToken) return
  file.tokens = { ...stored, refreshToken: '' }
  file.refused = { fingerprint: credentialFingerprint(stored.accessToken), status, code, message: message.trim().slice(0, 256) || `HTTP ${status}`, observedAtMs: now() } satisfies QwenSigninRefusal
  writeAuth(file)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function qwenPortalBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env[QWEN_PORTAL_SEAM_ENV]?.trim() || QWEN_PORTAL_BASE_URL).replace(/\/+$/, '')
}

function trustedResource(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim().replace(/\/+$/, '')
  const spelled = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(spelled)
    if (url.username || url.password || url.search || url.hash) return undefined
    const seam = env[QWEN_PORTAL_SEAM_ENV]?.trim()
    const loopback = seam ? new URL(seam) : undefined
    const sameBox = loopback !== undefined && ['127.0.0.1', 'localhost', '[::1]'].includes(loopback.hostname) && url.origin === loopback.origin
    if (!sameBox && !(url.protocol === 'https:' && (url.hostname === 'qwen.ai' || url.hostname.endsWith('.qwen.ai') || url.hostname.endsWith('.aliyuncs.com') || url.hostname.endsWith('.alibabacloud.com')))) return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

export function qwenPlanBase(tokens: Pick<QwenTokens, 'resourceUrl'> | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const seam = env['MERCURY_QWEN_API_BASE']?.trim()
  if (seam) return `${seam.replace(/\/+$/, '')}/plan`
  const resource = tokens?.resourceUrl ?? `https://${QWEN_PLAN_DEFAULT_RESOURCE}`
  return resource.endsWith('/v1') ? resource : `${resource}/v1`
}

export function tokensFromQwenBody(body: Record<string, unknown>, io?: QwenOauthIo, old?: QwenTokens): QwenTokens {
  if (typeof body.access_token !== 'string' || !body.access_token.trim()) throw new Error('the sign-in service returned no access token')
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.trim() ? body.refresh_token : old?.refreshToken
  if (!refreshToken) throw new Error('the sign-in service returned no refresh token')
  const now = io?.now?.() ?? Date.now()
  const expiresAtMs = positive(body.expires_in) ? now + body.expires_in * 1000 : old?.expiresAtMs
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : old?.scope
  const resourceUrl = trustedResource(body.resource_url, io?.env ?? process.env) ?? old?.resourceUrl
  return {
    accessToken: body.access_token,
    refreshToken,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(resourceUrl !== undefined ? { resourceUrl } : {}),
  }
}

export interface QwenPortalAnswer {
  status: number
  body: Record<string, unknown>
}

async function post(path: string, form: Record<string, string>, io: QwenOauthIo | undefined): Promise<QwenPortalAnswer> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(io?.fetchImpl ?? getApiFetch(), 'qwen', EXCHANGE_DEADLINE_MS, `${qwenPortalBase(io?.env)}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': getUserAgent(), 'x-request-id': randomUUID() },
      body: new URLSearchParams(form).toString(),
      ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch {
    throw new Error('the Qwen sign-in service did not answer')
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  return { status: response.status, body }
}

function described(body: Record<string, unknown>): string {
  return typeof body.error_description === 'string' && body.error_description.trim() ? body.error_description.trim() : typeof body.message === 'string' && body.message.trim() ? body.message.trim() : ''
}

export function qwenPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export interface QwenDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAtMs: number
  intervalSec: number
  codeVerifier: string
}

function verificationUrl(value: unknown, io?: QwenOauthIo): string {
  if (typeof value !== 'string') throw new Error('the sign-in service returned no verification URL')
  const url = new URL(value)
  const fixture = new URL(qwenPortalBase(io?.env))
  const trusted = (url.protocol === 'https:' && (url.hostname === 'qwen.ai' || url.hostname.endsWith('.qwen.ai'))) || (['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) && url.origin === fixture.origin)
  if (url.username || url.password || !trusted) throw new Error('the sign-in service returned an untrusted verification URL')
  return value
}

export async function startQwenDeviceAuth(io?: QwenOauthIo): Promise<QwenDeviceAuthStart> {
  const pkce = qwenPkcePair()
  const result = await post(DEVICE_CODE_PATH, { client_id: QWEN_OAUTH_CLIENT_ID, scope: QWEN_OAUTH_SCOPE, code_challenge: pkce.challenge, code_challenge_method: 'S256' }, io)
  if (result.status !== 200) {
    const words = described(result.body)
    throw new Error(`the Qwen sign-in service refused the device request (HTTP ${result.status}${words ? `: ${words}` : ''})`)
  }
  const b = result.body
  if (typeof b.device_code !== 'string' || !b.device_code || typeof b.user_code !== 'string' || !b.user_code) throw new Error('the sign-in service returned an incomplete device code')
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: verificationUrl(b.verification_uri, io),
    ...(typeof b.verification_uri_complete === 'string' && b.verification_uri_complete ? { verificationUriComplete: verificationUrl(b.verification_uri_complete, io) } : {}),
    expiresAtMs: (io?.now?.() ?? Date.now()) + (positive(b.expires_in) ? b.expires_in : DEFAULT_EXPIRES_SEC) * 1000,
    intervalSec: Math.max(1, positive(b.interval) ? b.interval : DEFAULT_POLL_SEC),
    codeVerifier: pkce.verifier,
  }
}

export type QwenDevicePoll =
  | { state: 'authorized'; tokens: QwenTokens }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'unavailable' }
  | { state: 'denied'; words: string }
  | { state: 'expired'; words: string }
  | { state: 'refused'; words: string }

export async function pollQwenDeviceToken(start: QwenDeviceAuthStart, io?: QwenOauthIo): Promise<QwenDevicePoll> {
  const result = await post(TOKEN_PATH, { grant_type: QWEN_DEVICE_CODE_GRANT, client_id: QWEN_OAUTH_CLIENT_ID, device_code: start.deviceCode, code_verifier: start.codeVerifier }, io)
  if (result.status === 200) {
    try {
      return { state: 'authorized', tokens: tokensFromQwenBody(result.body, io) }
    } catch (error) {
      return { state: 'refused', words: error instanceof Error ? error.message : String(error) }
    }
  }
  const code = typeof result.body.error === 'string' ? result.body.error : ''
  if (!code && (result.status === 408 || result.status === 429 || result.status >= 500)) return { state: 'unavailable' }
  const words = described(result.body) || `HTTP ${result.status}${code ? ` (${code})` : ''}`
  switch (code) {
    case 'authorization_pending':
      return { state: 'pending' }
    case 'slow_down':
      return { state: 'slow-down' }
    case 'access_denied':
      return { state: 'denied', words }
    case 'expired_token':
      return { state: 'expired', words }
    default:
      return { state: 'refused', words }
  }
}

export class QwenRefreshRefusedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'QwenRefreshRefusedError'
  }
}

function fresh(tokens: QwenTokens | undefined, now: number): tokens is QwenTokens {
  return tokens !== undefined && tokens.refreshToken.length > 0 && tokens.expiresAtMs !== undefined && tokens.expiresAtMs > now + REFRESH_SKEW_MS
}

const refreshes = new Map<string, Promise<QwenTokens | undefined>>()

export function refreshQwenTokens(io?: QwenOauthIo, force = false): Promise<QwenTokens | undefined> {
  const path = qwenAuthPathForDisplay()
  const existing = refreshes.get(path)
  if (existing) return existing
  const now = io?.now ?? Date.now
  const before = qwenStoredTokens()
  if (!before?.refreshToken) return Promise.resolve(undefined)
  if (!force && fresh(before, now())) return Promise.resolve(before)
  const work = (async (): Promise<QwenTokens | undefined> => {
    mkdirSync(getAuthConfigHomeDir(), { recursive: true })
    let release: () => Promise<void>
    try {
      release = await lock(path, { realpath: false, stale: 20_000, retries: { retries: 12, factor: 1.4, minTimeout: 150, maxTimeout: 1_200 } })
    } catch {
      const latest = qwenStoredTokens()
      if (latest?.refreshToken && (latest.refreshToken !== before.refreshToken || fresh(latest, now()))) return latest
      throw new Error('another Mercury is refreshing the Qwen account sign-in — the stored sign-in is kept; retry in a moment')
    }
    try {
      if (qwenAuthPathForDisplay() !== path) return undefined
      const old = qwenStoredTokens()
      if (!old?.refreshToken) return undefined
      if (old.refreshToken !== before.refreshToken) return old
      if (!force && fresh(old, now())) return old
      const result = await post(TOKEN_PATH, { grant_type: 'refresh_token', refresh_token: old.refreshToken, client_id: QWEN_OAUTH_CLIENT_ID }, io)
      const current = qwenStoredTokens()
      if (qwenAuthPathForDisplay() !== path || current?.refreshToken !== old.refreshToken) return current?.refreshToken ? current : undefined
      if (result.status === 200) {
        const tokens = tokensFromQwenBody(result.body, io, old)
        writeQwenTokens(tokens)
        return tokens
      }
      const code = typeof result.body.error === 'string' ? result.body.error : ''
      const words = described(result.body)
      if (result.status === 400 || result.status === 401 || code === 'invalid_grant' || code === 'invalid_token') {
        const verdict = code || 'invalid_grant'
        markQwenSigninRefused(old, result.status, verdict, words, now)
        throw new QwenRefreshRefusedError(qwenSigninRefusalNote({ status: result.status, code: verdict, message: words }), result.status, verdict)
      }
      throw new Error(`the Qwen sign-in service could not refresh the sign-in (HTTP ${result.status}${words ? `: ${words}` : ''}) — the stored sign-in is kept; retry shortly`)
    } finally {
      await release().catch(() => undefined)
    }
  })().finally(() => refreshes.delete(path))
  refreshes.set(path, work)
  return work
}

export function qwenSigninIdentity(tokens: QwenTokens | undefined): string {
  return tokens === undefined ? 'none' : `signin-${credentialFingerprint(tokens.refreshToken || tokens.accessToken)}`
}
