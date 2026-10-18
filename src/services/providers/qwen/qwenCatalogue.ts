import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { catalogueBodyJson, modelsEndpointUnreachable, quietBodyJson, serviceWordsOf, wordsNameTheKey, type ServiceWords } from '../catalogueBody.js'
import { qwenAccountIdentity, qwenBaseOverride, qwenBoundBase, qwenEndpointBase, qwenEndpointLabelOf, qwenListAnswersEveryCaller, qwenProbeLane, qwenSigninActive, qwenUnboundKeyRefusal, rememberQwenBoundBase, resolveQwenCredential, resolveQwenCredentialSnapshot, type QwenCredentialSource, type QwenEndpoint } from './qwenAccounts.js'
import { QWEN_SIGNIN_EXPIRED_LINE, qwenPlanBase, qwenSigninRefusal, qwenSigninRefusalNote, qwenStoredTokens } from './qwenOauth.js'
import { QWEN_DISPLAY_PINS, QWEN_OBSERVED_AT, isQwenTextModelId, qwenDisplayName, qwenDisplayPin, qwenEffortVocabulary, qwenPinWireId, qwenPinsFor, qwenPreservesThinking, qwenThinkingDial, type QwenPinScope, type QwenThinkingDial } from './qwenPins.js'

export interface QwenLiveModel {
  id: string
  created: number
  ownedBy?: string
}

export function decodeQwenModel(raw: unknown): QwenLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !isQwenTextModelId(row.id)) return undefined
  const created = typeof row.created === 'number' && Number.isFinite(row.created) && row.created >= 0 ? row.created : 0
  return { id: row.id.trim(), created, ...(typeof row.owned_by === 'string' ? { ownedBy: row.owned_by } : {}) }
}

export class QwenCatalogueHttpError extends Error {
  readonly refused: boolean
  readonly said: string | undefined
  constructor(readonly status: number, readonly endpointLabel: string, road: 'models' | 'chat' = 'models', words: ServiceWords = {}, key = '') {
    const refused = status === 401 || status === 403 || (status === 400 && wordsNameTheKey(words))
    const said = (words.message ?? words.code)?.split(key || '\0').join('[redacted]')
    super(`${refused
      ? `Model Studio ${endpointLabel} refused the credential (HTTP ${status})`
      : `Model Studio ${endpointLabel} ${road === 'chat' ? 'chat' : 'models'} endpoint returned HTTP ${status}`}${said ? ` — ${said}` : ''}`)
    this.refused = refused
    this.said = said
  }
}

const QWEN_CODING_PLAN_FALLBACK_MODEL = 'qwen3.5-plus'
const authenticatedCodingKeys = new Set<string>()

async function authenticateQwenCodingKey(opts: { baseUrl: string; key: string; model: string | undefined; fetchImpl?: typeof fetch; env: NodeJS.ProcessEnv }): Promise<void> {
  const memo = `${credentialFingerprint(opts.key)} ${opts.baseUrl}`
  if (authenticatedCodingKeys.has(memo)) return
  const label = qwenEndpointLabelOf(opts.baseUrl, opts.env)
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'qwen', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      body: JSON.stringify({ model: opts.model ?? QWEN_CODING_PLAN_FALLBACK_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw new Error(`Model Studio ${label} chat endpoint could not be reached (${error instanceof Error ? error.message : String(error)})`)
  }
  if (response.ok || response.status === 429) {
    authenticatedCodingKeys.add(memo)
    return
  }
  throw new QwenCatalogueHttpError(response.status, label, 'chat', serviceWordsOf(await quietBodyJson(response)), opts.key)
}

export async function fetchQwenLiveModels(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<{ models: QwenLiveModel[]; otherLines: number; fetchedAtMs: number }> {
  const env = opts.env ?? process.env
  const label = qwenEndpointLabelOf(opts.baseUrl, env)
  let response: Response
  try {
    response = await fetchWithProviderDeadline(opts.fetchImpl ?? getApiFetch(), 'qwen', 15_000, `${opts.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${opts.key}`, 'user-agent': getUserAgent() },
      ...(opts.fetchImpl ? {} : getProxyFetchOptions()),
    } as RequestInit)
  } catch (error) {
    throw modelsEndpointUnreachable(error) ?? error
  }
  if (!response.ok) throw new QwenCatalogueHttpError(response.status, label, 'models', serviceWordsOf(await quietBodyJson(response)), opts.key)
  const parsed = await catalogueBodyJson(response) as Record<string, unknown>
  if (!Array.isArray(parsed?.data)) throw new Error(`Model Studio ${label} models endpoint returned no data array`)
  const seen = new Set<string>()
  const models: QwenLiveModel[] = []
  let otherLines = 0
  for (const raw of parsed.data) {
    const model = decodeQwenModel(raw)
    if (!model) { otherLines++; continue }
    if (seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    models.push(model)
  }
  models.sort((a, b) => pinRank(a.id) - pinRank(b.id) || b.created - a.created || a.id.localeCompare(b.id))
  if (qwenListAnswersEveryCaller(opts.baseUrl, env)) {
    await authenticateQwenCodingKey({ baseUrl: opts.baseUrl, key: opts.key, model: models[0]?.id, env, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
  }
  return { models, otherLines, fetchedAtMs: Date.now() }
}

export type QwenProbeOutcome =
  | { kind: 'bound'; endpoint: QwenEndpoint; baseUrl: string; models: QwenLiveModel[]; otherLines: number; tried: number }
  | { kind: 'refused'; words: string; tried: number }
  | { kind: 'unreachable'; words: string; tried: number }

export async function probeQwenEndpoints(opts: { key: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<QwenProbeOutcome> {
  const env = opts.env ?? process.env
  const endpoints = qwenProbeLane(opts.key, env)
  const faults: string[] = []
  const refusalWords: string[] = []
  let refusals = 0
  for (const endpoint of endpoints) {
    const baseUrl = qwenEndpointBase(endpoint, env)
    try {
      const result = await fetchQwenLiveModels({ baseUrl, key: opts.key, env, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
      return { kind: 'bound', endpoint, baseUrl, models: result.models, otherLines: result.otherLines, tried: faults.length + refusals + 1 }
    } catch (error) {
      if (error instanceof QwenCatalogueHttpError && error.refused) {
        refusals++
        const said = error.said?.replace(/\.+$/, '')
        if (said && !refusalWords.includes(said)) refusalWords.push(said)
        continue
      }
      faults.push(`${endpoint.label}: ${(error instanceof Error ? error.message : String(error)).split(opts.key).join('[redacted]')}`)
    }
  }
  const tried = refusals + faults.length
  if (faults.length === 0) return { kind: 'refused', words: `${qwenUnboundKeyRefusal(env, opts.key)}${refusalWords.length > 0 ? `; the service said: ${refusalWords.join(' / ')}` : ''}`, tried }
  return { kind: 'unreachable', words: `${refusals} of ${endpoints.length} Model Studio endpoints refused the key and ${faults.length} could not be read (${faults.join('; ')})`, tried }
}

export interface QwenCatalogueSnapshot {
  keySource: QwenCredentialSource
  baseUrl?: string
  endpointLabel?: string
  models: QwenLiveModel[]
  otherLines: number
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

const cache = new Map<string, QwenCatalogueSnapshot>()
const inFlight = new Map<string, Promise<QwenCatalogueSnapshot | null>>()
export function qwenCatalogueIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const identity = identityOf(env)
  return identity === 'none' ? undefined : identity
}

function identityOf(env: NodeJS.ProcessEnv): string {
  if (qwenSigninActive(env)) return `signin:${qwenAccountIdentity(env)}:plan`
  const key = resolveQwenCredentialSnapshot(env)
  return key ? `${key.source}:${credentialFingerprint(key.key)}:${qwenBaseOverride(env) ?? 'bound'}` : 'none'
}

export function getCachedQwenCatalogue(env: NodeJS.ProcessEnv = process.env): QwenCatalogueSnapshot | null {
  return resolveQwenCredentialSnapshot(env) || qwenSigninActive(env) ? cache.get(identityOf(env)) ?? null : null
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const liveIdSets = new WeakMap<QwenCatalogueSnapshot, ReadonlySet<string>>()
export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (cache.size === 0) return EMPTY_IDS
  const snapshot = getCachedQwenCatalogue(env)
  if (!snapshot?.fetchedAtMs) return EMPTY_IDS
  let ids = liveIdSets.get(snapshot)
  if (!ids) {
    ids = new Set(snapshot.models.map(row => row.id.toLowerCase()))
    liveIdSets.set(snapshot, ids)
  }
  return ids
}

export function qwenListedModel(snapshot: QwenCatalogueSnapshot | null, id: string): QwenLiveModel | undefined {
  const wanted = id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  return snapshot?.models.find(row => row.id.toLowerCase() === wanted)
}

export function refreshQwenCatalogue(opts?: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<QwenCatalogueSnapshot | null> {
  const env = opts?.env ?? process.env
  const now = opts?.now ?? Date.now
  const signin = qwenSigninActive(env)
  const key = signin ? undefined : resolveQwenCredentialSnapshot(env)
  const identity = identityOf(env)
  const cached = key || signin ? cache.get(identity) ?? null : null
  if ((!key && !signin) || !catalogueTrafficVerdict('qwen', env).allowed) return Promise.resolve(cached)
  const anchor = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
  if (!opts?.force && cached && now() - anchor < (cached.lastError ? 10_000 : 300_000)) return Promise.resolve(cached)
  const running = inFlight.get(identity)
  if (running) return running
  const fetchImpl = opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}
  const work = (async (): Promise<QwenCatalogueSnapshot | null> => {
    try {
      if (signin) {
        const credential = await resolveQwenCredential({ env, ...fetchImpl })
        if (credential === undefined) {
          const refusal = qwenSigninRefusal()
          const snapshot: QwenCatalogueSnapshot = { keySource: 'signin', models: [], otherLines: 0, fetchedAtMs: 0, lastAttemptAtMs: now(), lastError: `the plan refused the credential: ${refusal ? qwenSigninRefusalNote(refusal) : QWEN_SIGNIN_EXPIRED_LINE}` }
          cache.set(identity, snapshot)
          return snapshot
        }
        const planBase = qwenPlanBase(qwenStoredTokens(), env)
        const result = await fetchQwenLiveModels({ baseUrl: planBase, key: credential.apiKey, env, ...fetchImpl })
        const snapshot: QwenCatalogueSnapshot = { keySource: 'signin', baseUrl: planBase, endpointLabel: 'the Qwen account plan', models: result.models, otherLines: result.otherLines, fetchedAtMs: now() }
        cache.set(identity, snapshot)
        return snapshot
      }
      const bound = qwenBoundBase(env)
      if (bound !== undefined) {
        const result = await fetchQwenLiveModels({ baseUrl: bound, key: key!.key, env, ...fetchImpl })
        const snapshot: QwenCatalogueSnapshot = { keySource: key!.source, baseUrl: bound, endpointLabel: qwenEndpointLabelOf(bound, env), models: result.models, otherLines: result.otherLines, fetchedAtMs: now() }
        cache.set(identity, snapshot)
        return snapshot
      }
      const probe = await probeQwenEndpoints({ key: key!.key, env, ...fetchImpl })
      if (probe.kind === 'bound') {
        rememberQwenBoundBase(key!.key, probe.baseUrl)
        const snapshot: QwenCatalogueSnapshot = { keySource: key!.source, baseUrl: probe.baseUrl, endpointLabel: probe.endpoint.label, models: probe.models, otherLines: probe.otherLines, fetchedAtMs: now() }
        cache.set(identity, snapshot)
        return snapshot
      }
      const snapshot: QwenCatalogueSnapshot = {
        keySource: key!.source, models: [], otherLines: 0, fetchedAtMs: 0, lastAttemptAtMs: now(),
        lastError: probe.kind === 'refused' ? `Model Studio refused the credential on every endpoint: ${probe.words}` : probe.words,
      }
      cache.set(identity, snapshot)
      return snapshot
    } catch (error) {
      const refused = error instanceof QwenCatalogueHttpError && error.refused
      const secret = key?.key ?? qwenStoredTokens()?.accessToken ?? ''
      const snapshot: QwenCatalogueSnapshot = {
        keySource: key?.source ?? 'signin', ...(cached?.baseUrl !== undefined ? { baseUrl: cached.baseUrl, endpointLabel: cached.endpointLabel } : {}),
        models: refused ? [] : cached?.models ?? [], otherLines: cached?.otherLines ?? 0, fetchedAtMs: refused ? 0 : cached?.fetchedAtMs ?? 0,
        lastAttemptAtMs: now(), lastError: secret ? (error instanceof Error ? error.message : String(error)).split(secret).join('[redacted]') : (error instanceof Error ? error.message : String(error)),
      }
      cache.set(identity, snapshot)
      return snapshot
    } finally {
      inFlight.delete(identity)
      bumpCatalogueEpoch()
    }
  })()
  inFlight.set(identity, work)
  return work
}

export interface QwenCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}
export type QwenCatalogueSource = { kind: 'live'; count: number; otherLines: number; fetchedAtMs: number } | { kind: 'plan'; count: number; fetchedAtMs: number } | { kind: 'pins' } | { kind: 'unread' }

export function qwenPinScope(env: NodeJS.ProcessEnv = process.env, snapshot: QwenCatalogueSnapshot | null = getCachedQwenCatalogue(env)): QwenPinScope {
  if (snapshot ? snapshot.keySource === 'signin' : qwenSigninActive(env)) return 'account-plan'
  const base = snapshot?.baseUrl ?? qwenBoundBase(env)
  return base !== undefined && qwenListAnswersEveryCaller(base, env) ? 'coding-plan' : 'pay-as-you-go'
}

function pinRow(pin: (typeof QWEN_DISPLAY_PINS)[number], listedLive: boolean): QwenCatalogueRow {
  return { id: pin.id, displayName: pin.displayName, observedAt: QWEN_OBSERVED_AT, ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}), listedLive }
}

export function qwenPinRows(env: NodeJS.ProcessEnv = process.env, scope: QwenPinScope = qwenPinScope(env)): QwenCatalogueRow[] {
  return qwenPinsFor(scope).map(pin => pinRow(pin, false))
}

const pinRank = (id: string): number => {
  const index = QWEN_DISPLAY_PINS.findIndex(pin => pin.id === id.toLowerCase())
  return index === -1 ? QWEN_DISPLAY_PINS.length : index
}

export function qwenCatalogueRows(env: NodeJS.ProcessEnv = process.env): { rows: QwenCatalogueRow[]; source: QwenCatalogueSource } {
  const snapshot = getCachedQwenCatalogue(env)
  if (!snapshot) return { rows: [], source: { kind: 'unread' } }
  const scope = qwenPinScope(env, snapshot)
  if (scope === 'coding-plan' && snapshot.fetchedAtMs > 0) {
    const rows = qwenPinRows(env, scope)
    return { rows, source: { kind: 'plan', count: rows.length, fetchedAtMs: snapshot.fetchedAtMs } }
  }
  if (snapshot.models.length === 0) return !snapshot.lastError?.includes('refused the credential') && (snapshot.fetchedAtMs > 0 || Boolean(snapshot.lastError)) ? { rows: qwenPinRows(env, scope), source: { kind: 'pins' } } : { rows: [], source: { kind: 'unread' } }
  const created = new Map(snapshot.models.map(model => [model.id.toLowerCase(), model.created]))
  const live = snapshot.models.map(model => {
    const pin = qwenDisplayPin(model.id)
    return pin ? pinRow(pin, true) : { id: model.id, displayName: qwenDisplayName(model.id), observedAt: new Date(snapshot.fetchedAtMs).toISOString().slice(0, 10), listedLive: true }
  })
  const unlisted = qwenPinsFor(scope).filter(pin => !created.has(pin.id)).map(pin => pinRow(pin, false))
  const rows = [...live, ...unlisted].sort((a, b) => pinRank(a.id) - pinRank(b.id) || (created.get(b.id.toLowerCase()) ?? 0) - (created.get(a.id.toLowerCase()) ?? 0) || a.id.localeCompare(b.id))
  return { rows, source: { kind: 'live', count: live.length, otherLines: snapshot.otherLines, fetchedAtMs: snapshot.fetchedAtMs } }
}

export function newestQwenModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return qwenCatalogueRows(env).rows[0]?.id
}

export function qwenWireId(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const asked = model.trim().replace(/\[(?:[0-9]+m|served)\]/gi, '')
  return qwenListedModel(getCachedQwenCatalogue(env), asked)?.id ?? (qwenDisplayPin(asked) ? qwenPinWireId(asked) : asked)
}

export function qwenCatalogueSourceWords(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const snapshot = getCachedQwenCatalogue(env)
  const { source } = qwenCatalogueRows(env)
  if (source.kind === 'plan') return `the Coding Plan's documented models (observed ${QWEN_OBSERVED_AT}) on ${snapshot?.endpointLabel ?? 'the Coding Plan endpoint'} — its model list answers every caller and is not the plan's list`
  if (source.kind === 'pins') return `pinned list (observed ${QWEN_OBSERVED_AT}) — ${snapshot?.lastError ? `the live list could not be read: ${snapshot.lastError}` : 'the live list returned no text models'}`
  if (snapshot?.lastError) return snapshot.lastError
  return source.kind === 'live' ? `${source.count} text ${source.count === 1 ? 'model' : 'models'} live on ${snapshot?.endpointLabel ?? 'Model Studio'}${source.otherLines > 0 ? ` · ${source.otherLines} of other lines not listed` : ''}` : undefined
}

export function qwenModelFacts(id: string): { contextWindow?: number; outputMax?: number; thinking: QwenThinkingDial; preservesThinking: boolean; efforts: readonly string[]; images?: boolean } {
  const pin = qwenDisplayPin(id)
  return {
    ...(pin ? { ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}), ...(pin.outputMax !== undefined ? { outputMax: pin.outputMax } : {}), images: pin.images } : {}),
    thinking: qwenThinkingDial(id),
    preservesThinking: qwenPreservesThinking(id),
    efforts: qwenEffortVocabulary(id),
  }
}

export function forgetQwenCatalogue(): void {
  cache.clear()
  inFlight.clear()
}

export function __resetQwenCatalogueForTest(): void {
  forgetQwenCatalogue()
  authenticatedCodingKeys.clear()
}
