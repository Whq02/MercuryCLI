import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { getAuthConfigHomeDir } from '../../../platform/environment/envUtils.js'
import { durableAtomicPublishSync } from '../../../platform/substrate/durablePublish.js'
import { getApiFetch, getProxyFetchOptions } from '../../../platform/network/proxy.js'
import { getUserAgent } from '../requestHeaders.js'
import { noteCredentialChange } from '../../sign-in/account-ledger/signInLedger.js'
import { refuseProofWriteIntoAccountStore } from '../proofHomeGuard.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { lockedRefresh } from '../../sign-in/lifecycle/lockedRefresh.js'

const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const EXCHANGE_DEADLINE_MS = 15_000
const REFRESH_SKEW_MS = 120_000
interface XaiTokens {
  accessToken: string
  refreshToken: string
  expiresAtMs?: number
  email?: string
}
export interface XaiOauthIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
}
interface AuthFile {
  version: number
  tokens?: XaiTokens
  preferredSource?: 'grok-subscription' | 'api-key'
  [key: string]: unknown
}
export function xaiAuthPathForDisplay(): string { return join(getAuthConfigHomeDir(), '.xai-auth.json') }
function readAuth(): AuthFile {
  try {
    const value = JSON.parse(readFileSync(xaiAuthPathForDisplay(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { version: 1 }
  } catch { return { version: 1 } }
}
function writeAuth(file: AuthFile): void {
  refuseProofWriteIntoAccountStore(getAuthConfigHomeDir(), 'the auth file .xai-auth.json')
  mkdirSync(getAuthConfigHomeDir(), { recursive: true })
  const { credentialFileUnwritten, credentialJsonToWriteOver } = require('../../sign-in/account-ledger/providerSecrets.js') as typeof import('../../sign-in/account-ledger/providerSecrets.js')
  const path = xaiAuthPathForDisplay()
  credentialJsonToWriteOver('The xAI auth file', 'xai-auth', path)
  try {
    durableAtomicPublishSync(path, JSON.stringify({ ...file, version: 1 }) + '\n', { mode: 0o600 })
  } catch (error) {
    throw credentialFileUnwritten('The xAI auth file', path, error)
  }
  noteCredentialChange()
}
export function xaiStoredTokens(): XaiTokens | undefined {
  const tokens = readAuth().tokens
  return tokens && typeof tokens.accessToken === 'string' && typeof tokens.refreshToken === 'string' ? tokens : undefined
}
export function writeXaiTokens(tokens: XaiTokens | null): void {
  const file = readAuth()
  if (tokens) file.tokens = tokens
  else delete file.tokens
  writeAuth(file)
}
export function clearStoredXaiSubscription(): void { writeXaiTokens(null) }
export function readPreferredXaiSource(): AuthFile['preferredSource'] { return readAuth().preferredSource }
export function writePreferredXaiSource(source: NonNullable<AuthFile['preferredSource']>): void {
  writeAuth({ ...readAuth(), preferredSource: source })
}
function xaiAuthBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return (flagEnv('MERCURY_XAI_AUTH_BASE', env)?.trim() || 'https://auth.x.ai').replace(/\/+$/, '')
}
function jwt(token: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch (error) { passedOver(error); return {} }
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function tokensFromBody(body: Record<string, unknown>, io?: XaiOauthIo, old?: XaiTokens): XaiTokens {
  if (typeof body.access_token !== 'string' || !body.access_token.trim()) throw new Error('xAI returned no access token.')
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.trim() ? body.refresh_token : old?.refreshToken
  if (!refreshToken) throw new Error('xAI returned no refresh token; sign in again with offline access.')
  const claims = jwt(body.access_token)
  const identity = typeof body.id_token === 'string' ? jwt(body.id_token) : {}
  const expiresAtMs = positive(body.expires_in) ? (io?.now?.() ?? Date.now()) + body.expires_in * 1000 : positive(claims.exp) ? claims.exp * 1000 : undefined
  const email = typeof identity.email === 'string' && identity.email.length < 256 && !/[\x00-\x1f\x7f]/.test(identity.email) ? identity.email : old?.email
  return { accessToken: body.access_token, refreshToken, ...(expiresAtMs ? { expiresAtMs } : {}), ...(email ? { email } : {}) }
}
async function exchange(path: string, body: Record<string, string>, io?: XaiOauthIo): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetchWithProviderDeadline(io?.fetchImpl ?? getApiFetch(), 'xai', EXCHANGE_DEADLINE_MS, `${xaiAuthBase(io?.env)}${path}`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': getUserAgent() },
      body: new URLSearchParams(body).toString(), ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch { throw new Error('xAI authorization endpoint did not answer; retry from /logins xai.') }
  let parsed: unknown
  try { parsed = await response.json() } catch { throw new Error(`xAI authorization returned non-JSON (HTTP ${response.status}).`) }
  return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} }
}
export interface XaiDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAtMs: number
  intervalSec: number
}
function verificationUrl(value: unknown, io?: XaiOauthIo): string {
  if (typeof value !== 'string') throw new Error('xAI returned no verification URL.')
  if (!URL.canParse(value)) throw new Error('xAI returned an invalid verification URL; retry from /logins xai.')
  const url = new URL(value)
  const fixture = new URL(xaiAuthBase(io?.env))
  if (url.username || url.password || !((url.protocol === 'https:' && (url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))) || (['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) && url.origin === fixture.origin))) throw new Error('xAI returned an untrusted verification URL.')
  return value
}
export async function startXaiDeviceAuth(io?: XaiOauthIo): Promise<XaiDeviceAuthStart> {
  const result = await exchange('/oauth2/device/code', { client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE, referrer: 'mercury' }, io)
  if (result.status !== 200) throw new Error(`xAI refused the device-code request (HTTP ${result.status}).`)
  const b = result.body
  if (typeof b.device_code !== 'string' || !b.device_code || typeof b.user_code !== 'string' || !b.user_code) throw new Error('xAI returned an incomplete device code.')
  return { deviceCode: b.device_code, userCode: b.user_code, verificationUri: verificationUrl(b.verification_uri, io),
    ...(b.verification_uri_complete ? { verificationUriComplete: verificationUrl(b.verification_uri_complete, io) } : {}),
    expiresAtMs: (io?.now?.() ?? Date.now()) + (positive(b.expires_in) ? b.expires_in : 300) * 1000,
    intervalSec: Math.max(1, positive(b.interval) ? b.interval : 5) }
}
export async function pollXaiDeviceToken(start: XaiDeviceAuthStart, io?: XaiOauthIo): Promise<
  { state: 'authorized'; tokens: XaiTokens } | { state: 'pending' | 'slow-down' | 'denied' | 'expired' | 'refused' }
> {
  const result = await exchange('/oauth2/token', { client_id: XAI_OAUTH_CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.deviceCode }, io)
  if (result.status === 200) {
    try { return { state: 'authorized', tokens: tokensFromBody(result.body, io) } } catch { return { state: 'refused' } }
  }
  switch (result.body.error) {
    case 'authorization_pending': return { state: 'pending' }
    case 'slow_down': return { state: 'slow-down' }
    case 'access_denied': case 'authorization_denied': return { state: 'denied' }
    case 'expired_token': return { state: 'expired' }
    default: return { state: 'refused' }
  }
}
const refreshGrokSignIn = lockedRefresh<XaiTokens>()
export async function refreshXaiTokens(io?: XaiOauthIo, force = false): Promise<XaiTokens | undefined> {
  const answer = await refreshGrokSignIn({
    path: xaiAuthPathForDisplay(),
    exchangeDeadlineMs: EXCHANGE_DEADLINE_MS,
    refreshLockFile: 'stale-by-holder',
    force,
    read: xaiStoredTokens,
    write: writeXaiTokens,
    fresh: pair => pair.expiresAtMs !== undefined && pair.expiresAtMs > (io?.now?.() ?? Date.now()) + REFRESH_SKEW_MS,
    exchange: async old => {
      const result = await exchange('/oauth2/token', { client_id: XAI_OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: old.refreshToken }, io)
      if (result.status === 200) return { state: 'refreshed', pair: tokensFromBody(result.body, io, old) }
      const failed = new Error(`Grok sign-in refresh failed (HTTP ${result.status}); /logins xai reconnects it. No API-key fallback was used.`)
      if (result.status >= 400 && result.status < 500 && result.body.error === 'invalid_grant') return { state: 'dead', error: failed }
      throw failed
    },
  })
  switch (answer.state) {
    case 'refreshed':
    case 'current':
      return answer.pair
    case 'absent':
      return undefined
    case 'dead':
    case 'failed':
      throw answer.error
    case 'busy':
      throw new Error('Another process is refreshing Grok; retry after it finishes.')
  }
}
