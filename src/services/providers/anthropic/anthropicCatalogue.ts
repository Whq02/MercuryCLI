import { anthropicAccountApiBase, OAUTH_BETA_HEADER } from '../../../constants/oauth.js'
import { getAnthropicApiKey, getClaudeAIOAuthTokens } from '../../../utils/auth.js'
import { getUserAgent } from '../../../utils/http.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { isOAuthTokenExpired } from '../../oauth/client.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable } from '../catalogueBody.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const ANTHROPIC_CATALOGUE_TTL_MS = 5 * 60_000
const ANTHROPIC_CATALOGUE_FAILURE_RETRY_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_PAGE_LIMIT = 1000
const ANTHROPIC_MAX_PAGES = 5

export const ANTHROPIC_DOORS = ['subscription', 'api-key', 'bearer'] as const
export type AnthropicDoor = (typeof ANTHROPIC_DOORS)[number]

export const ANTHROPIC_DOOR_LABELS: Record<AnthropicDoor, string> = {
  subscription: 'Claude subscription',
  'api-key': 'Anthropic API key',
  bearer: 'Anthropic bearer token (ANTHROPIC_AUTH_TOKEN)',
}

export const ANTHROPIC_TOKEN_EXPIRED_WORDS = 'the claude.ai access token has expired — the next chat turn refreshes it'

export interface AnthropicLiveModel {
  id: string
  displayName?: string
  createdAt?: string
}

export interface AnthropicDoorCredential {
  door: AnthropicDoor
  label: string
  headers: Record<string, string>
  fingerprint: string
  expired?: boolean
}

export interface AnthropicDoorSnapshot {
  door: AnthropicDoor
  label: string
  models: AnthropicLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
  lastStatus?: number
}

export type AnthropicDoorState =
  | { door: AnthropicDoor; label: string; state: 'pending' }
  | { door: AnthropicDoor; label: string; state: 'error'; lastError: string; lastAttemptAtMs: number; lastStatus?: number }
  | { door: AnthropicDoor; label: string; state: 'ready'; count: number; fetchedAtMs: number; lastError?: string }

export interface AnthropicLiveRow {
  id: string
  displayName?: string
  doors: string[]
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function decodeAnthropicModel(raw: unknown): AnthropicLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return undefined
  const displayName = str(r.display_name)
  const createdAt = str(r.created_at)
  return {
    id: id.trim(),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export class AnthropicCatalogueHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(
      status === 401 || status === 403
        ? `anthropic models endpoint refused the credential (HTTP ${status})`
        : `anthropic models endpoint returned HTTP ${status}`,
    )
    this.name = 'AnthropicCatalogueHttpError'
    this.status = status
  }
}

export async function fetchAnthropicLiveModels(opts: {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<{ models: AnthropicLiveModel[]; fetchedAtMs: number }> {
  const fetchImpl = opts.fetchImpl ?? getApiFetch()
  const proxyOptions = opts.fetchImpl ? {} : getProxyFetchOptions({ forAnthropicAPI: true })
  const base = opts.baseUrl.replace(/\/+$/, '')
  const models: AnthropicLiveModel[] = []
  let after: string | undefined
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(ANTHROPIC_PAGE_LIMIT) })
    if (after !== undefined) params.set('after_id', after)
    let response: Response
    try {
      response = await fetchWithProviderDeadline(fetchImpl, 'anthropic', CATALOGUE_FETCH_TIMEOUT_MS, `${base}/v1/models?${params.toString()}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'user-agent': getUserAgent(),
          ...opts.headers,
        },
        ...(proxyOptions as Record<string, unknown>),
      } as RequestInit)
    } catch (error) {
      throw modelsEndpointUnreachable(error) ?? error
    }
    if (!response.ok) throw new AnthropicCatalogueHttpError(response.status)
    const parsed = (await catalogueBodyJson(response)) as Record<string, unknown>
    const data = Array.isArray(parsed.data) ? parsed.data : []
    for (const raw of data) {
      const model = decodeAnthropicModel(raw)
      if (model) models.push(model)
    }
    const lastId = str(parsed.last_id)
    if (parsed.has_more !== true || lastId === undefined) break
    after = lastId
  }
  return { models, fetchedAtMs: Date.now() }
}

function subscriptionDoor(): AnthropicDoorCredential | undefined {
  let tokens: ReturnType<typeof getClaudeAIOAuthTokens>
  try {
    tokens = getClaudeAIOAuthTokens()
  } catch {
    return undefined
  }
  const accessToken = tokens?.accessToken
  if (!accessToken) return undefined
  return {
    door: 'subscription',
    label: ANTHROPIC_DOOR_LABELS.subscription,
    headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA_HEADER },
    fingerprint: credentialFingerprint(accessToken),
    ...(isOAuthTokenExpired(tokens?.expiresAt ?? null) ? { expired: true } : {}),
  }
}

function apiKeyDoor(): AnthropicDoorCredential | undefined {
  let key: string | null
  try {
    key = getAnthropicApiKey()
  } catch {
    return undefined
  }
  if (!key) return undefined
  return {
    door: 'api-key',
    label: ANTHROPIC_DOOR_LABELS['api-key'],
    headers: { 'x-api-key': key },
    fingerprint: credentialFingerprint(key),
  }
}

function bearerDoor(env: NodeJS.ProcessEnv): AnthropicDoorCredential | undefined {
  const token = env.ANTHROPIC_AUTH_TOKEN
  if (!token || token.trim() === '') return undefined
  return {
    door: 'bearer',
    label: ANTHROPIC_DOOR_LABELS.bearer,
    headers: { authorization: `Bearer ${token}` },
    fingerprint: credentialFingerprint(token),
  }
}

export function anthropicDoors(env: NodeJS.ProcessEnv = process.env): AnthropicDoorCredential[] {
  const doors: AnthropicDoorCredential[] = []
  const subscription = subscriptionDoor()
  if (subscription) doors.push(subscription)
  const apiKey = apiKeyDoor()
  if (apiKey) doors.push(apiKey)
  const bearer = bearerDoor(env)
  if (bearer) doors.push(bearer)
  return doors
}

function listBase(env: NodeJS.ProcessEnv): string {
  const pinned = env.ANTHROPIC_BASE_URL
  if (pinned && pinned.trim() !== '') return pinned.trim()
  return anthropicAccountApiBase()
}

function doorIdentity(credential: AnthropicDoorCredential, env: NodeJS.ProcessEnv): string {
  let base = ''
  try {
    base = listBase(env)
  } catch {
    base = 'unresolved'
  }
  return `${credential.door}:${credential.fingerprint}:${base}`
}

const catalogueCache = new Map<string, AnthropicDoorSnapshot>()
const catalogueInFlight = new Map<string, Promise<AnthropicDoorSnapshot>>()

export function getCachedAnthropicDoorCatalogue(door: AnthropicDoor, env: NodeJS.ProcessEnv = process.env): AnthropicDoorSnapshot | null {
  const credential = anthropicDoors(env).find(candidate => candidate.door === door)
  if (!credential) return null
  return catalogueCache.get(doorIdentity(credential, env)) ?? null
}

function nothingUsable(snapshot: AnthropicDoorSnapshot | null): boolean {
  return snapshot === null || (snapshot.models.length === 0 && snapshot.lastError !== undefined)
}

function sameRows(a: AnthropicLiveModel[], b: AnthropicLiveModel[]): boolean {
  if (a.length !== b.length) return false
  return a.every((row, index) => row.id === b[index]?.id && row.displayName === b[index]?.displayName)
}

function refreshDoor(
  credential: AnthropicDoorCredential,
  opts: { force?: boolean; fetchImpl?: typeof fetch; env: NodeJS.ProcessEnv; now: () => number },
): Promise<AnthropicDoorSnapshot> {
  const identity = doorIdentity(credential, opts.env)
  const cached = catalogueCache.get(identity) ?? null
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  const window = cached && nothingUsable(cached) ? ANTHROPIC_CATALOGUE_FAILURE_RETRY_MS : ANTHROPIC_CATALOGUE_TTL_MS
  if (!opts.force && cached && opts.now() - anchor < window) return Promise.resolve(cached)
  const existing = catalogueInFlight.get(identity)
  if (existing) return existing
  const work = (async (): Promise<AnthropicDoorSnapshot> => {
    const failed = (error: unknown): AnthropicDoorSnapshot => ({
      door: credential.door,
      label: credential.label,
      models: cached?.models ?? [],
      fetchedAtMs: cached?.fetchedAtMs ?? 0,
      lastAttemptAtMs: opts.now(),
      lastError: error instanceof Error ? error.message : String(error),
      ...(error instanceof AnthropicCatalogueHttpError ? { lastStatus: error.status } : {}),
    })
    try {
      if (credential.expired === true) {
        const snapshot = failed(new Error(ANTHROPIC_TOKEN_EXPIRED_WORDS))
        catalogueCache.set(identity, snapshot)
        return snapshot
      }
      const result = await fetchAnthropicLiveModels({
        baseUrl: listBase(opts.env),
        headers: credential.headers,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const snapshot: AnthropicDoorSnapshot = {
        door: credential.door,
        label: credential.label,
        models: result.models,
        fetchedAtMs: opts.now(),
        lastAttemptAtMs: opts.now(),
      }
      catalogueCache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const snapshot = failed(error)
      catalogueCache.set(identity, snapshot)
      return snapshot
    } finally {
      catalogueInFlight.delete(identity)
      const settled = catalogueCache.get(identity)
      if (settled !== undefined && (settled.lastError !== cached?.lastError || !sameRows(settled.models, cached?.models ?? []))) {
        bumpCatalogueEpoch()
      }
    }
  })()
  catalogueInFlight.set(identity, work)
  return work
}

export function refreshAnthropicCatalogue(opts?: {
  door?: AnthropicDoor
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<AnthropicDoorSnapshot[]> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const doors = anthropicDoors(env).filter(credential => opts?.door === undefined || credential.door === opts.door)
  if (doors.length === 0) return Promise.resolve([])
  if (!catalogueTrafficVerdict('anthropic', env).allowed) {
    return Promise.resolve(doors.map(credential => catalogueCache.get(doorIdentity(credential, env))).filter((snapshot): snapshot is AnthropicDoorSnapshot => snapshot !== undefined))
  }
  return Promise.all(
    doors.map(credential =>
      refreshDoor(credential, {
        env,
        now,
        ...(opts?.force !== undefined ? { force: opts.force } : {}),
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    ),
  )
}

export function kickAnthropicCatalogue(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  const env = opts?.env ?? process.env
  if (!catalogueTrafficVerdict('anthropic', env).allowed) return false
  const pending = anthropicDoors(env).filter(credential => nothingUsable(catalogueCache.get(doorIdentity(credential, env)) ?? null))
  if (pending.length === 0) return false
  for (const credential of pending) {
    void refreshAnthropicCatalogue({ env, door: credential.door, ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }).catch(() => [])
  }
  return true
}

export function anthropicCatalogueDoorStates(env: NodeJS.ProcessEnv = process.env): AnthropicDoorState[] {
  return anthropicDoors(env).map((credential): AnthropicDoorState => {
    const snapshot = catalogueCache.get(doorIdentity(credential, env)) ?? null
    if (snapshot === null) return { door: credential.door, label: credential.label, state: 'pending' }
    if (snapshot.models.length > 0 || (snapshot.fetchedAtMs > 0 && snapshot.lastError === undefined)) {
      return {
        door: credential.door,
        label: credential.label,
        state: 'ready',
        count: snapshot.models.length,
        fetchedAtMs: snapshot.fetchedAtMs,
        ...(snapshot.lastError !== undefined ? { lastError: snapshot.lastError } : {}),
      }
    }
    if (snapshot.lastError !== undefined) {
      return {
        door: credential.door,
        label: credential.label,
        state: 'error',
        lastError: snapshot.lastError,
        lastAttemptAtMs: snapshot.lastAttemptAtMs ?? 0,
        ...(snapshot.lastStatus !== undefined ? { lastStatus: snapshot.lastStatus } : {}),
      }
    }
    return { door: credential.door, label: credential.label, state: 'pending' }
  })
}

export function anthropicLiveUnion(env: NodeJS.ProcessEnv = process.env): AnthropicLiveRow[] {
  const rows = new Map<string, AnthropicLiveRow>()
  for (const credential of anthropicDoors(env)) {
    const snapshot = catalogueCache.get(doorIdentity(credential, env))
    if (snapshot === undefined || snapshot.models.length === 0) continue
    for (const model of snapshot.models) {
      const key = model.id.trim().toLowerCase()
      const existing = rows.get(key)
      if (existing !== undefined) {
        if (!existing.doors.includes(credential.label)) existing.doors.push(credential.label)
        if (existing.displayName === undefined && model.displayName !== undefined) existing.displayName = model.displayName
        continue
      }
      rows.set(key, {
        id: model.id.trim(),
        ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
        doors: [credential.label],
      })
    }
  }
  return [...rows.values()]
}

export function anthropicListedModel(id: string, env: NodeJS.ProcessEnv = process.env): AnthropicLiveRow | undefined {
  const key = id.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
  return anthropicLiveUnion(env).find(row => row.id.toLowerCase() === key)
}

export function __resetAnthropicCatalogueForTest(): void {
  catalogueCache.clear()
  catalogueInFlight.clear()
}
