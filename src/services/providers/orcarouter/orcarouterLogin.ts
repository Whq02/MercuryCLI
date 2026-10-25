import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { writeStoredOrcarouterApiKey } from '../providerSecrets.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { orcarouterApiBase } from './orcarouterAccounts.js'
import { fetchOrcarouterLiveModels, OrcarouterCatalogueHttpError } from './orcarouterCatalogue.js'

export const ORCAROUTER_CONNECT_ROWS = [
  { label: 'Sign in with your OrcaRouter account — browser approval', value: 'device' },
  { label: 'Paste an API key (model gateway)', value: 'key' },
]

export async function storeOrcarouterApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<{ ok: boolean; stored: boolean; receipt: string }> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty OrcaRouter API key.' }
  try {
    await fetchOrcarouterLiveModels({ baseUrl: orcarouterApiBase(io?.env), key, fetchImpl: io?.fetchImpl })
  } catch (error) {
    if (error instanceof OrcarouterCatalogueHttpError && (error.status === 401 || error.status === 403)) return { ok: false, stored: false, receipt: `OrcaRouter refused this key (HTTP ${error.status}) — create a key at orcarouter.ai/console/token and paste again.` }
  }
  try {
    writeStoredOrcarouterApiKey(key)
    recordSignIn('orcarouter', 'api-key')
  } catch { return { ok: false, stored: false, receipt: 'Could not store the OrcaRouter key — retry from /logins orcarouter.' } }
  const shadow = (io?.env ?? process.env).ORCAROUTER_API_KEY?.trim() ? ' ORCAROUTER_API_KEY is set and wins over this stored key.' : ''
  return { ok: true, stored: true, receipt: `OrcaRouter API key stored. Requests bill OrcaRouter credits.${shadow}` }
}

interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAtMs: number
  intervalSec: number
}
export type OrcarouterDeviceLoginEvent =
  | { phase: 'starting' | 'finishing' }
  | { phase: 'waiting'; start: DeviceStart; polls: number }

interface LoginIo {
  fetchImpl?: typeof fetch
  discoveryUrl?: string
  now?: () => number
}

function trustedUrl(raw: unknown, origin: string): string {
  if (typeof raw !== 'string') throw new Error('OrcaRouter sign-in discovery is missing an endpoint')
  const url = new URL(raw)
  const allowed = new URL(origin)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.origin !== allowed.origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new Error('OrcaRouter sign-in discovery returned an insecure or unexpected endpoint; paste an API key instead')
  }
  return url.toString().replace(/\/$/, '')
}

export async function runOrcarouterDeviceLogin(args: {
  io?: LoginIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: OrcarouterDeviceLoginEvent) => void
} = {}): Promise<{ ok: boolean; receipt: string; settledAfterCancel?: true }> {
  const io = args.io ?? {}
  const now = io.now ?? Date.now
  const cancelled = args.cancelled ?? (() => false)
  const sleep = args.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const fail = (message: string): { ok: false; receipt: string } => ({ ok: false, receipt: `${message} — /logins orcarouter retries or stores an API key.` })
  const request = async (url: string, body?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetchWithProviderDeadline(io.fetchImpl ?? getApiFetch(), 'orcarouter', 15_000, url, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': getProductUserAgent() },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(io.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
    const parsed = await response.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OrcaRouter sign-in returned no object')
    return { status: response.status, body: parsed as Record<string, unknown> }
  }
  args.onEvent?.({ phase: 'starting' })
  if (cancelled()) return fail('OrcaRouter sign-in cancelled')
  let issuer: string
  let start: DeviceStart
  try {
    const discoveryUrl = io.discoveryUrl ?? 'https://www.orcarouter.ai/.well-known/openid-configuration'
    const origin = new URL(discoveryUrl).origin
    trustedUrl(discoveryUrl, origin)
    const discovery = await request(discoveryUrl)
    if (discovery.status !== 200) throw new Error('OrcaRouter sign-in discovery did not answer')
    issuer = trustedUrl(discovery.body.issuer, origin)
    trustedUrl(discovery.body.authorization_endpoint, origin)
    trustedUrl(discovery.body.token_endpoint, origin)
    if (cancelled()) return fail('OrcaRouter sign-in cancelled')
    const result = await request(`${issuer}/api/v1/auth/device/code`, { app_name: 'Mercury', scope: 'api' })
    if (result.status !== 200) return fail(`OrcaRouter sign-in could not start (HTTP ${result.status})`)
    const body = result.body
    if (typeof body.device_code !== 'string' || !body.device_code || typeof body.user_code !== 'string' || !body.user_code || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || typeof body.interval !== 'number' || !Number.isFinite(body.interval) || body.interval <= 0) return fail('OrcaRouter sign-in returned an incomplete device code')
    start = { deviceCode: body.device_code, userCode: body.user_code, verificationUri: trustedUrl(body.verification_uri, origin),
      ...(body.verification_uri_complete !== undefined ? { verificationUriComplete: trustedUrl(body.verification_uri_complete, origin) } : {}),
      expiresAtMs: now() + body.expires_in * 1000, intervalSec: body.interval }
  } catch (error) {
    return fail(error instanceof Error && error.message.startsWith('OrcaRouter sign-in') ? error.message : 'OrcaRouter sign-in could not start')
  }
  let interval = start.intervalSec
  let polls = 0
  args.onEvent?.({ phase: 'waiting', start, polls })
  while (!cancelled() && now() < start.expiresAtMs) {
    await sleep(Math.min(interval * 1000, Math.max(0, start.expiresAtMs - now())))
    if (cancelled() || now() >= start.expiresAtMs) break
    let result: Awaited<ReturnType<typeof request>>
    try { result = await request(`${issuer}/api/v1/auth/device/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.deviceCode }) }
    catch { interval *= 2; continue }
    polls++
    if (result.status === 400 && result.body.error === 'authorization_pending') { args.onEvent?.({ phase: 'waiting', start, polls }); continue }
    if (result.status === 400 && result.body.error === 'slow_down') { interval += 5; continue }
    if (result.status >= 500) { interval *= 2; continue }
    if (result.status !== 200) return fail(`OrcaRouter sign-in ${result.body.error === 'access_denied' ? 'was declined' : result.body.error === 'expired_token' ? 'code expired' : 'was refused'}`)
    const key = result.body.key
    if (typeof key !== 'string' || !key.startsWith('sk-orca-') || result.body.scope !== 'api') return fail('OrcaRouter sign-in returned no inference key')
    args.onEvent?.({ phase: 'finishing' })
    try { writeStoredOrcarouterApiKey(key); recordSignIn('orcarouter', 'oauth') }
    catch { return fail('OrcaRouter approved the sign-in but storing the key failed') }
    if (cancelled()) return { ok: true, settledAfterCancel: true, receipt: 'OrcaRouter sign-in completed after cancel — /accounts removes the key.' }
    return { ok: true, receipt: 'OrcaRouter connected. Requests bill OrcaRouter credits.' }
  }
  return fail(cancelled() ? 'OrcaRouter sign-in cancelled' : 'OrcaRouter sign-in code expired')
}
