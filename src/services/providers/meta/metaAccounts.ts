import { readFileSync } from 'node:fs'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { publishAuthScopedJson, readStoredMetaApiKey, signInLedgerPath } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'

export const MUSE_CODE_OAUTH_CLIENT_ID = '1031625952748946'
export const META_API_VERSION = '1.0.0'
export const META_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const META_AUTH_FILE_NAME = '.meta-auth.json'
const META_EXCHANGE_TIMEOUT_MS = 20_000
const META_DEFAULT_INTERVAL_SEC = 5

export type MetaSourceKind = 'muse-code' | 'api-key'

export interface MetaUsageWindowRecord {
  usedPercent?: number
  resetsAtMs?: number
  windowDurationMins?: number
}

export interface MetaSubsUsageRecord {
  window?: MetaUsageWindowRecord
  weekly?: MetaUsageWindowRecord
}

export interface MetaMuseCodeGrant {
  accessToken: string
  apiKey: string
  userId?: string
  email?: string
  tierId?: string
  tierName?: string
  usage?: MetaSubsUsageRecord
  observedAtMs: number
}

interface MetaAuthFile {
  version: number
  museCode?: MetaMuseCodeGrant
  preferredSource?: MetaSourceKind
  [k: string]: unknown
}

export function metaApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_META_API_BASE?.trim() || 'https://api.meta.ai/v1').replace(/\/+$/, '')
}

export function metaChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${metaApiBase(env)}/chat/completions`
}

export function metaAuthBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MERCURY_META_API_BASE?.trim()
  return (override ? override.replace(/\/+$/, '').replace(/\/v1$/, '') : 'https://auth.meta.com').replace(/\/+$/, '')
}

export function metaDeviceAuthUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${metaAuthBase(env)}/oidc/device/authorization/`
}

export function metaDeviceTokenUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${metaAuthBase(env)}/oidc/device/token/`
}

export function metaMuseCodeKeyUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MERCURY_META_API_BASE?.trim()
  const host = (override ? override.replace(/\/+$/, '').replace(/\/v1$/, '') : 'https://api.meta.ai').replace(/\/+$/, '')
  return `${host}/muse-code/key`
}

export function metaAuthPathForDisplay(): string {
  return signInLedgerPath(META_AUTH_FILE_NAME)
}

function readAuthFile(): MetaAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(metaAuthPathForDisplay(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as MetaAuthFile
  } catch {
    return null
  }
}

export function parseMetaResetAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed)
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric < 1e11 ? Math.round(numeric * 1000) : Math.round(numeric)
      }
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function decodeWindowRecord(raw: unknown): MetaUsageWindowRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const usedRaw = obj.used_percent ?? obj.usedPercent
  const usedPercent = typeof usedRaw === 'number' && Number.isFinite(usedRaw) ? Math.min(100, Math.max(0, usedRaw)) : undefined
  const resetsAtMs = parseMetaResetAtMs(obj.resets_at ?? obj.resetsAtMs)
  const minsRaw = obj.window_duration_mins ?? obj.windowDurationMins
  const windowDurationMins = typeof minsRaw === 'number' && Number.isFinite(minsRaw) && minsRaw > 0 ? minsRaw : undefined
  if (usedPercent === undefined && resetsAtMs === undefined && windowDurationMins === undefined) return undefined
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  }
}

export function decodeMetaSubsUsage(raw: unknown): MetaSubsUsageRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const window = decodeWindowRecord(obj.window)
  const weekly = decodeWindowRecord(obj.weekly)
  if (!window && !weekly) return undefined
  return {
    ...(window ? { window } : {}),
    ...(weekly ? { weekly } : {}),
  }
}

export function readMetaMuseCodeGrant(): MetaMuseCodeGrant | undefined {
  const raw = readAuthFile()?.museCode
  if (typeof raw !== 'object' || raw === null) return undefined
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken.trim() : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  if (!accessToken || !apiKey) return undefined
  const usage = decodeMetaSubsUsage(raw.usage)
  return {
    accessToken,
    apiKey,
    ...(typeof raw.userId === 'string' && raw.userId.trim() ? { userId: raw.userId.trim() } : {}),
    ...(typeof raw.email === 'string' && raw.email.trim() ? { email: raw.email.trim() } : {}),
    ...(typeof raw.tierId === 'string' && raw.tierId.trim() ? { tierId: raw.tierId.trim() } : {}),
    ...(typeof raw.tierName === 'string' && raw.tierName.trim() ? { tierName: raw.tierName.trim() } : {}),
    ...(usage ? { usage } : {}),
    observedAtMs: typeof raw.observedAtMs === 'number' && Number.isFinite(raw.observedAtMs) ? raw.observedAtMs : 0,
  }
}

export function writeMetaMuseCodeGrant(grant: MetaMuseCodeGrant | null): void {
  publishAuthScopedJson(META_AUTH_FILE_NAME, file => {
    const next = { ...file }
    if (grant === null) {
      delete next.museCode
      if (next.preferredSource === 'muse-code') delete next.preferredSource
    } else {
      next.museCode = grant
    }
    return next
  })
  bumpCatalogueEpoch()
}

export function disconnectMetaMuseCode(): void {
  writeMetaMuseCodeGrant(null)
}

export function metaMuseCodeConnected(): boolean {
  return readMetaMuseCodeGrant() !== undefined
}

export type MetaMuseCodeFacts = Omit<MetaMuseCodeGrant, 'accessToken' | 'apiKey'>

export function metaMuseCodeFacts(): MetaMuseCodeFacts | undefined {
  const grant = readMetaMuseCodeGrant()
  if (!grant) return undefined
  const { accessToken: _a, apiKey: _k, ...facts } = grant
  return facts
}

export function readPreferredMetaSource(): MetaSourceKind | undefined {
  const value = readAuthFile()?.preferredSource
  return value === 'muse-code' || value === 'api-key' ? value : undefined
}

export function writePreferredMetaSource(kind: MetaSourceKind | null): void {
  publishAuthScopedJson(META_AUTH_FILE_NAME, file => {
    const next = { ...file }
    if (kind === null) delete next.preferredSource
    else next.preferredSource = kind
    return next
  })
  bumpCatalogueEpoch()
}

export function metaEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'MODEL_API_KEY' | 'META_API_KEY' } | undefined {
  for (const name of ['MODEL_API_KEY', 'META_API_KEY'] as const) {
    const key = env[name]?.trim()
    if (key) return { key, name }
  }
  return undefined
}

export function resolveMetaRawApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: 'env' | 'stored'; envName?: 'MODEL_API_KEY' | 'META_API_KEY' } | undefined {
  const key = metaEnvKey(env)
  if (key) return { key: key.key, source: 'env', envName: key.name }
  const fromCommand = resolveProviderKeyCommand('meta')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredMetaApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface MetaAccountRef {
  kind: MetaSourceKind
  label: string
  keySource?: 'env' | 'stored'
  email?: string
  tierName?: string
  observedAtMs?: number
}

export function resolveMetaAccount(env: NodeJS.ProcessEnv = process.env): MetaAccountRef | undefined {
  const grant = readMetaMuseCodeGrant()
  const tier = grant?.tierName ?? grant?.tierId
  const museRef: MetaAccountRef | undefined = grant
    ? {
        kind: 'muse-code',
        label: `Muse Code (${tier ?? 'subscription'})`,
        ...(grant.email ? { email: grant.email } : {}),
        ...(tier ? { tierName: tier } : {}),
        ...(grant.observedAtMs ? { observedAtMs: grant.observedAtMs } : {}),
      }
    : undefined
  const rawKey = resolveMetaRawApiKey(env)
  const keyRef: MetaAccountRef | undefined = rawKey
    ? {
        kind: 'api-key',
        label: rawKey.source === 'env' ? `${rawKey.envName!} (env)` : 'Meta API key (stored, auth-scoped)',
        keySource: rawKey.source,
      }
    : undefined
  const preferred = readPreferredMetaSource()
  if (preferred === 'api-key') return keyRef ?? museRef
  if (preferred === 'muse-code') return museRef ?? keyRef
  return museRef ?? keyRef
}

export function resolveMetaApiKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; source: 'env' | 'stored' | 'muse-code' } | undefined {
  const account = resolveMetaAccount(env)
  if (!account) return undefined
  if (account.kind === 'muse-code') {
    const grant = readMetaMuseCodeGrant()
    return grant ? { key: grant.apiKey, source: 'muse-code' } : undefined
  }
  const rawKey = resolveMetaRawApiKey(env)
  return rawKey ? { key: rawKey.key, source: rawKey.source } : undefined
}

export interface MetaDeviceAuthStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  intervalSec: number
  expiresAtMs: number
}

export type MetaDevicePollResult =
  | { state: 'authorized'; accessToken: string }
  | { state: 'pending' }
  | { state: 'slow-down' }
  | { state: 'denied'; code: string; description?: string }
  | { state: 'unreachable'; message: string }

export interface MetaOauthIo {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}

async function postMetaOidcForm(
  url: string,
  form: Record<string, string>,
  io?: MetaOauthIo,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  const response = await fetchWithProviderDeadline(fetchImpl, 'meta', META_EXCHANGE_TIMEOUT_MS, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-api-version': META_API_VERSION,
      'user-agent': getUserAgent(),
    },
    body: new URLSearchParams(form).toString(),
    ...(proxyOptions as Record<string, unknown>),
  } as RequestInit)
  let body: Record<string, unknown> = {}
  try {
    const parsed = (await response.json()) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {}
  return { status: response.status, body }
}

export async function startMetaDeviceAuth(io?: MetaOauthIo): Promise<MetaDeviceAuthStart> {
  const env = io?.env ?? process.env
  const { status, body } = await postMetaOidcForm(
    metaDeviceAuthUrl(env),
    { client_id: MUSE_CODE_OAUTH_CLIENT_ID },
    io,
  )
  const deviceCode = typeof body.device_code === 'string' ? body.device_code.trim() : ''
  const userCode = typeof body.user_code === 'string' ? body.user_code.trim() : ''
  const verificationUri = typeof body.verification_uri === 'string' ? body.verification_uri.trim() : ''
  if (status !== 200 || !deviceCode || !userCode || !verificationUri) {
    const detail = typeof body.error === 'string' ? ` — ${body.error}` : ''
    throw new Error(`Meta device authorization refused (HTTP ${status}${detail})`)
  }
  const now = io?.now?.() ?? Date.now()
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 300
  const intervalSec = typeof body.interval === 'number' && body.interval > 0 ? body.interval : META_DEFAULT_INTERVAL_SEC
  const complete = typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete.trim() : ''
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete ? { verificationUriComplete: complete } : {}),
    intervalSec,
    expiresAtMs: now + expiresIn * 1000,
  }
}

export async function pollMetaDeviceToken(
  start: Pick<MetaDeviceAuthStart, 'deviceCode'>,
  io?: MetaOauthIo,
): Promise<MetaDevicePollResult> {
  const env = io?.env ?? process.env
  let posted: { status: number; body: Record<string, unknown> }
  try {
    posted = await postMetaOidcForm(
      metaDeviceTokenUrl(env),
      {
        client_id: MUSE_CODE_OAUTH_CLIENT_ID,
        device_code: start.deviceCode,
        grant_type: META_DEVICE_GRANT,
      },
      io,
    )
  } catch (error) {
    return { state: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
  const { status, body } = posted
  const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''
  if (status === 200 && accessToken) return { state: 'authorized', accessToken }
  const error = typeof body.error === 'string' ? body.error : `http-${status}`
  if (error === 'authorization_pending') return { state: 'pending' }
  if (error === 'slow_down') return { state: 'slow-down' }
  return {
    state: 'denied',
    code: error,
    ...(typeof body.error_description === 'string' ? { description: body.error_description } : {}),
  }
}

export type MuseCodeKeyExchangeResult =
  | {
      state: 'ok'
      apiKey?: string
      userId?: string
      email?: string
      isSubsActive?: boolean
      tierId?: string
      tierName?: string
      usage?: MetaSubsUsageRecord
      requirePayment?: boolean
      actionUrl?: string
      message?: string
      observedAtMs: number
    }
  | { state: 'refused'; status: number; message?: string }
  | { state: 'unreachable'; message: string }

function scrubToken(text: string, token: string): string {
  return token ? text.split(token).join('[redacted]') : text
}

export async function requestMuseCodeKey(
  accessToken: string,
  io?: MetaOauthIo & { onboard?: boolean },
): Promise<MuseCodeKeyExchangeResult> {
  const env = io?.env ?? process.env
  const fetchImpl = io?.fetchImpl ?? getApiFetch()
  const proxyOptions = io?.fetchImpl ? {} : getProxyFetchOptions()
  const now = io?.now?.() ?? Date.now()
  let response: Response
  try {
    response = await fetchWithProviderDeadline(fetchImpl, 'meta', META_EXCHANGE_TIMEOUT_MS, metaMuseCodeKeyUrl(env), {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-api-version': META_API_VERSION,
        'user-agent': getUserAgent(),
      },
      body: JSON.stringify(io?.onboard ? { onboard: true } : {}),
      ...(proxyOptions as Record<string, unknown>),
    } as RequestInit)
  } catch (error) {
    return {
      state: 'unreachable',
      message: scrubToken(error instanceof Error ? error.message : String(error), accessToken),
    }
  }
  const text = await response.text()
  let parsed: Record<string, unknown> | undefined
  try {
    const json = JSON.parse(text) as unknown
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      parsed = json as Record<string, unknown>
    }
  } catch {}
  if (!response.ok) {
    const errorObj = typeof parsed?.error === 'object' && parsed.error !== null ? (parsed.error as Record<string, unknown>) : undefined
    const msg =
      (typeof errorObj?.message === 'string' && errorObj.message.trim()) ||
      (typeof parsed?.message === 'string' && parsed.message.trim()) ||
      (typeof parsed?.error_description === 'string' && parsed.error_description.trim()) ||
      (typeof parsed?.error === 'string' && parsed.error.trim()) ||
      (text.trim() ? text.trim().slice(0, 300) : '')
    return {
      state: 'refused',
      status: response.status,
      ...(msg ? { message: scrubToken(msg, accessToken) } : {}),
    }
  }
  if (!parsed) {
    return { state: 'refused', status: response.status, message: 'invalid JSON from key endpoint' }
  }
  const apiKey = typeof parsed.api_key === 'string' && parsed.api_key.trim() ? parsed.api_key.trim() : undefined
  const email = typeof parsed.user_email === 'string' && parsed.user_email.trim() ? parsed.user_email.trim().toLowerCase() : undefined
  const userId = typeof parsed.user_id === 'string' && parsed.user_id.trim() ? parsed.user_id.trim() : undefined
  const isSubsActive = typeof parsed.is_subs_active === 'boolean' ? parsed.is_subs_active : undefined
  const tierId = typeof parsed.subs_tier_id === 'string' && parsed.subs_tier_id.trim() ? parsed.subs_tier_id.trim() : undefined
  const tierName = typeof parsed.subs_tier_name === 'string' && parsed.subs_tier_name.trim() ? parsed.subs_tier_name.trim() : undefined
  const usage = decodeMetaSubsUsage(parsed.subs_usage)
  const requirePayment = parsed.require_payment === true
  const actionUrl =
    (typeof parsed.action_url === 'string' && parsed.action_url.trim() ? parsed.action_url.trim() : undefined) ??
    (typeof parsed.require_payment_action_url === 'string' && parsed.require_payment_action_url.trim()
      ? parsed.require_payment_action_url.trim()
      : undefined)
  const message =
    (typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : undefined) ??
    (typeof parsed.error_description === 'string' && parsed.error_description.trim() ? parsed.error_description.trim() : undefined)
  return {
    state: 'ok',
    ...(apiKey ? { apiKey } : {}),
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
    ...(isSubsActive !== undefined ? { isSubsActive } : {}),
    ...(tierId ? { tierId } : {}),
    ...(tierName ? { tierName } : {}),
    ...(usage ? { usage } : {}),
    ...(requirePayment ? { requirePayment: true } : {}),
    ...(actionUrl ? { actionUrl } : {}),
    ...(message ? { message: scrubToken(message, accessToken) } : {}),
    observedAtMs: now,
  }
}
