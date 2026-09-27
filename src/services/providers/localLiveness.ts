import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getApiFetch } from '../../utils/proxy.js'
import { getUserAgent } from '../../utils/http.js'
import { fetchWithProviderDeadline } from './fetchDeadline.js'
import { resolveLocalApiKey } from './local/localAccounts.js'
import { localModelRecord, type LocalModelRecord, type LocalServerKind } from './local/localDiscovery.js'
import { LOCAL_SERVER_NAMES } from './local/localCatalogue.js'
import { REAL_STREAM_TIMERS, type StreamTimers } from './streamIdleBudget.js'

export const LOCAL_FIRST_BYTE_CAP_MS = 2 * 60 * 60_000
export const LOCAL_REQUEST_CAP_MS = LOCAL_FIRST_BYTE_CAP_MS
export const LOCAL_PROMISE_MARGIN = 1.25
export const LOCAL_PROMISE_FLOOR_MS = 60_000
export const LOCAL_LIVENESS_PROBE_TIMEOUT_MS = 5_000
export const LOCAL_LIVENESS_RETRY_GAP_MS = 10_000
export const LOCAL_LIVENESS_RECHECK_MS = 60_000
export const LOCAL_LOADING_POLL_MS = 5_000
export const LOCAL_PACE_SMALL_TOKENS_PER_S = 300
export const LOCAL_PACE_MEDIUM_TOKENS_PER_S = 100
export const LOCAL_PACE_LARGE_TOKENS_PER_S = 40
export const LOCAL_PACE_UNSTATED_TOKENS_PER_S = 100
export const LOCAL_PACE_SMALL_MAX_BILLIONS = 10
export const LOCAL_PACE_MEDIUM_MAX_BILLIONS = 35
export const LOCAL_PACE_MIN_TOKENS = 1_000
export const LOCAL_PACE_MIN_INGEST_MS = 5_000
export const LOCAL_PACE_BLEND_SAMPLES = 3
export const LOCAL_PACE_STORE_FILE = 'local-ingest-pace.json'
export const LOCAL_DEAD_SERVER_CODE = 'local-server-dead'
export const LOCAL_CAP_CODE = 'local-cap'

export function parameterBillionsOf(size: string | undefined): number | null {
  if (size === undefined) return null
  const match = /(\d+(?:\.\d+)?)\s*([bmt])\b/i.exec(size)
  if (match === null) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2]!.toLowerCase()
  if (unit === 'm') return value / 1000
  if (unit === 't') return value * 1000
  return value
}

export function localPaceDefaultFor(parameterSize: string | undefined): number {
  const billions = parameterBillionsOf(parameterSize)
  if (billions === null) return LOCAL_PACE_UNSTATED_TOKENS_PER_S
  if (billions <= LOCAL_PACE_SMALL_MAX_BILLIONS) return LOCAL_PACE_SMALL_TOKENS_PER_S
  if (billions <= LOCAL_PACE_MEDIUM_MAX_BILLIONS) return LOCAL_PACE_MEDIUM_TOKENS_PER_S
  return LOCAL_PACE_LARGE_TOKENS_PER_S
}

export function localFirstBytePromiseMs(uncachedTokens: number, paceTokensPerSec: number): number {
  const tokens = Number.isFinite(uncachedTokens) && uncachedTokens > 0 ? uncachedTokens : 0
  const pace = Number.isFinite(paceTokensPerSec) && paceTokensPerSec > 0 ? paceTokensPerSec : LOCAL_PACE_UNSTATED_TOKENS_PER_S
  return Math.max(LOCAL_PROMISE_FLOOR_MS, Math.round((tokens / pace) * LOCAL_PROMISE_MARGIN * 1000))
}

export function localPromiseExtensionMs(promiseMs: number): number {
  return Math.max(LOCAL_PROMISE_FLOOR_MS, Math.round(promiseMs / 2))
}

export interface LocalPaceRecord {
  paceTokensPerSec: number
  samples: number
  lastPromptTokens?: number
  updatedAtMs: number
}

interface LocalPaceStore {
  version: 1
  models: Record<string, LocalPaceRecord>
}

let loaded: LocalPaceStore | null = null

export function localPaceStorePath(): string {
  return join(getMercuryHome(), LOCAL_PACE_STORE_FILE)
}

function readStore(): LocalPaceStore {
  if (loaded !== null) return loaded
  let store: LocalPaceStore = { version: 1, models: {} }
  try {
    const parsed = JSON.parse(readFileSync(localPaceStorePath(), 'utf8')) as Partial<LocalPaceStore>
    if (parsed !== null && typeof parsed === 'object' && parsed.models !== null && typeof parsed.models === 'object') {
      const models: Record<string, LocalPaceRecord> = {}
      for (const [id, raw] of Object.entries(parsed.models)) {
        const r = raw as Partial<LocalPaceRecord> | null
        if (r === null || typeof r !== 'object') continue
        if (typeof r.paceTokensPerSec !== 'number' || !Number.isFinite(r.paceTokensPerSec) || r.paceTokensPerSec <= 0) continue
        models[id] = {
          paceTokensPerSec: r.paceTokensPerSec,
          samples: typeof r.samples === 'number' && r.samples > 0 ? Math.floor(r.samples) : 1,
          ...(typeof r.lastPromptTokens === 'number' && r.lastPromptTokens > 0 ? { lastPromptTokens: r.lastPromptTokens } : {}),
          updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
        }
      }
      store = { version: 1, models }
    }
  } catch {
    store = { version: 1, models: {} }
  }
  loaded = store
  return store
}

function writeStore(store: LocalPaceStore): void {
  loaded = store
  try {
    const path = localPaceStorePath()
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    return
  }
}

export function rememberedLocalPace(wireModel: string): LocalPaceRecord | null {
  const record = readStore().models[wireModel]
  return record === undefined ? null : { ...record }
}

export function recordLocalIngestPace(args: { wireModel: string; promptTokens: number; cachedTokens?: number; ingestMs: number; nowMs?: number }): LocalPaceRecord | null {
  const uncached = Math.max(0, (Number.isFinite(args.promptTokens) ? args.promptTokens : 0) - (args.cachedTokens ?? 0))
  if (uncached < LOCAL_PACE_MIN_TOKENS || !Number.isFinite(args.ingestMs) || args.ingestMs < LOCAL_PACE_MIN_INGEST_MS) return null
  const measured = uncached / (args.ingestMs / 1000)
  const store = readStore()
  const previous = store.models[args.wireModel]
  const weight = previous === undefined ? 0 : Math.min(previous.samples, LOCAL_PACE_BLEND_SAMPLES)
  const pace = previous === undefined ? measured : (previous.paceTokensPerSec * weight + measured) / (weight + 1)
  const next: LocalPaceRecord = {
    paceTokensPerSec: Math.round(pace * 10) / 10,
    samples: (previous?.samples ?? 0) + 1,
    lastPromptTokens: Math.max(1, Math.round(args.promptTokens)),
    updatedAtMs: args.nowMs ?? Date.now(),
  }
  writeStore({ version: 1, models: { ...store.models, [args.wireModel]: next } })
  return { ...next }
}

export function noteLocalPromptSize(wireModel: string, promptTokens: number, nowMs: number = Date.now()): void {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return
  const store = readStore()
  const previous = store.models[wireModel]
  if (previous === undefined) return
  writeStore({ version: 1, models: { ...store.models, [wireModel]: { ...previous, lastPromptTokens: Math.round(promptTokens), updatedAtMs: nowMs } } })
}

export function __resetLocalPaceForTest(): void {
  loaded = null
}

export function localUncachedEstimate(args: { cold: boolean; promptTokens: number; remembered: LocalPaceRecord | null }): number {
  const total = Math.max(0, Number.isFinite(args.promptTokens) ? args.promptTokens : 0)
  if (args.cold) return total
  const last = args.remembered?.lastPromptTokens
  if (last === undefined) return total
  return Math.max(LOCAL_PACE_MIN_TOKENS, total - last)
}

export function localServerRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function localServerWords(kind: LocalServerKind, baseUrl: string): string {
  let host = localServerRoot(baseUrl)
  try {
    host = new URL(localServerRoot(baseUrl)).host
  } catch {
    host = localServerRoot(baseUrl)
  }
  return `${LOCAL_SERVER_NAMES[kind]} at ${host}`
}

export function localLivenessProbeUrl(kind: LocalServerKind, baseUrl: string): string {
  const root = localServerRoot(baseUrl)
  switch (kind) {
    case 'ollama':
      return `${root}/api/version`
    case 'lmstudio':
      return `${root}/api/v1/models`
    case 'llamacpp':
      return `${root}/health`
    case 'vllm':
    case 'openai-compatible':
      return `${root}/v1/models`
  }
}

export function localLoadedProbeUrl(kind: LocalServerKind, baseUrl: string): string | null {
  const root = localServerRoot(baseUrl)
  switch (kind) {
    case 'ollama':
      return `${root}/api/ps`
    case 'lmstudio':
      return `${root}/api/v1/models`
    case 'llamacpp':
      return `${root}/health`
    case 'vllm':
    case 'openai-compatible':
      return null
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

export function localLoadedFromAnswer(kind: LocalServerKind, wireModel: string, status: number, body: unknown): boolean | null {
  if (kind === 'ollama') {
    const models = asRecord(body)?.models
    if (!Array.isArray(models)) return null
    const wanted = wireModel.toLowerCase()
    return models.some(m => {
      const r = asRecord(m)
      const name = typeof r?.model === 'string' ? r.model : typeof r?.name === 'string' ? r.name : ''
      return name.toLowerCase() === wanted
    })
  }
  if (kind === 'lmstudio') {
    const models = asRecord(body)?.models
    if (!Array.isArray(models)) return null
    const wanted = wireModel.toLowerCase()
    const row = models.map(asRecord).find(r => typeof r?.key === 'string' && r.key.toLowerCase() === wanted)
    if (row === undefined) return null
    return Array.isArray(row.loaded_instances) && row.loaded_instances.length > 0
  }
  if (kind === 'llamacpp') {
    if (status === 200) return true
    if (status === 503) return false
    return null
  }
  return null
}

export function localSizeGbFromTags(body: unknown, wireModel: string): number | undefined {
  const models = asRecord(body)?.models
  if (!Array.isArray(models)) return undefined
  const wanted = wireModel.toLowerCase()
  for (const m of models) {
    const r = asRecord(m)
    const name = typeof r?.model === 'string' ? r.model : typeof r?.name === 'string' ? r.name : ''
    if (name.toLowerCase() !== wanted) continue
    const size = r?.size
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) return Math.round(size / 1e8) / 10
  }
  return undefined
}

export interface LocalProbeIo {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

async function probeAnswer(url: string, io: LocalProbeIo): Promise<{ status: number; body: unknown } | null> {
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const key = resolveLocalApiKey(io.env ?? process.env)
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'local', io.timeoutMs ?? LOCAL_LIVENESS_PROBE_TIMEOUT_MS, url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': getUserAgent(),
        ...(key ? { authorization: `Bearer ${key.key}` } : {}),
      },
    } as RequestInit)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  } catch {
    return null
  }
}

export interface LocalLivenessSeam {
  probe(): Promise<boolean>
  loaded(): Promise<boolean | null>
  sizeGb(): Promise<number | undefined>
}

export function localLivenessSeamFor(record: Pick<LocalModelRecord, 'id' | 'server' | 'baseUrl'>, io: LocalProbeIo = {}): LocalLivenessSeam {
  return {
    async probe() {
      return (await probeAnswer(localLivenessProbeUrl(record.server, record.baseUrl), io)) !== null
    },
    async loaded() {
      const url = localLoadedProbeUrl(record.server, record.baseUrl)
      if (url === null) return null
      const answer = await probeAnswer(url, io)
      if (answer === null) return null
      return localLoadedFromAnswer(record.server, record.id, answer.status, answer.body)
    },
    async sizeGb() {
      if (record.server !== 'ollama') return undefined
      const answer = await probeAnswer(`${localServerRoot(record.baseUrl)}/api/tags`, io)
      return answer === null ? undefined : localSizeGbFromTags(answer.body, record.id)
    },
  }
}

export interface LocalStreamLaw {
  wireModel: string
  serverWords: string
  cold: boolean
  promiseMs: number
  paceTokensPerSec: number
  uncachedTokens: number
  loadedAtSend: boolean | undefined
  capMs: number
  seam: LocalLivenessSeam
  noteTurn(measured: { promptTokens: number; cachedTokens?: number; ingestMs: number }): void
}

export function localStreamLawFor(args: {
  wireModel: string
  cold: boolean
  promptTokens: number
  record?: LocalModelRecord
  io?: LocalProbeIo
  nowMs?: number
}): LocalStreamLaw | undefined {
  const record = args.record ?? localModelRecord(args.wireModel)
  if (record === undefined) return undefined
  const remembered = rememberedLocalPace(args.wireModel)
  const pace = remembered?.paceTokensPerSec ?? localPaceDefaultFor(record.parameterSize)
  const uncached = localUncachedEstimate({ cold: args.cold, promptTokens: args.promptTokens, remembered })
  const wireModel = args.wireModel
  const cold = args.cold
  return {
    wireModel,
    serverWords: localServerWords(record.server, record.baseUrl),
    cold,
    promiseMs: localFirstBytePromiseMs(uncached, pace),
    paceTokensPerSec: pace,
    uncachedTokens: uncached,
    loadedAtSend: record.loaded,
    capMs: LOCAL_REQUEST_CAP_MS,
    seam: localLivenessSeamFor(record, args.io),
    noteTurn(measured) {
      if (cold) {
        const recorded = recordLocalIngestPace({ wireModel, promptTokens: measured.promptTokens, cachedTokens: measured.cachedTokens, ingestMs: measured.ingestMs, nowMs: args.nowMs })
        if (recorded !== null) return
      }
      noteLocalPromptSize(wireModel, measured.promptTokens, args.nowMs)
    },
  }
}

export function isLocalLivenessCut(fault: { kind: string; code: string }): boolean {
  return fault.kind === 'timeout' && (fault.code === LOCAL_DEAD_SERVER_CODE || fault.code === LOCAL_CAP_CODE)
}

export function localDeadServerLine(serverWords: string, unansweredMs: number, phase: 'ingesting' | 'writing'): string {
  const s = Math.max(1, Math.round(unansweredMs / 1000))
  return `no answer from ${serverWords} for ${s} s while ${phase} — the local server is not responding (its window, its load, or a crash); /model re-probes`
}

export function localCapLine(model: string, elapsedMs: number, phase: 'ingesting' | 'writing'): string {
  const hours = Math.max(1, Math.round(elapsedMs / 3_600_000))
  const cap = `${hours}h`
  return phase === 'ingesting'
    ? `no first byte from ${model} after ${cap} — the ${cap} cap on a local request is reached; the server still answered its liveness probe`
    : `${model} was still writing after ${cap} — the ${cap} cap on a local request is reached and the reply so far stands`
}

export interface LocalLivenessLoop {
  stop(): void
  running(): boolean
}

export function startLocalLivenessLoop(args: {
  timers?: StreamTimers
  dueMs: number
  probe(): Promise<boolean>
  onAlive(elapsedMs: number): number | null
  onDead(elapsedMs: number, unansweredMs: number): void
  retryGapMs?: number
}): LocalLivenessLoop {
  const timers = args.timers ?? REAL_STREAM_TIMERS
  const startedAt = timers.now()
  const gap = args.retryGapMs ?? LOCAL_LIVENESS_RETRY_GAP_MS
  let stopped = false
  let handle: unknown = null
  let inFlight = false
  function arm(ms: number): void {
    if (stopped) return
    handle = timers.setTimeout(onLocalLivenessDue, Math.max(0, ms))
  }
  function onLocalLivenessDue(): void {
    handle = null
    if (stopped || inFlight) return
    inFlight = true
    void (async () => {
      const askedAt = timers.now()
      let answered = false
      try {
        answered = await args.probe()
      } catch {
        answered = false
      }
      if (!answered && !stopped) {
        await new Promise<void>(resolve => timers.setTimeout(resolve, gap))
        if (!stopped) {
          try {
            answered = await args.probe()
          } catch {
            answered = false
          }
        }
      }
      inFlight = false
      if (stopped) return
      const elapsed = timers.now() - startedAt
      if (!answered) {
        stopped = true
        args.onDead(elapsed, timers.now() - askedAt)
        return
      }
      const next = args.onAlive(elapsed)
      if (next === null) {
        stopped = true
        return
      }
      arm(next)
    })()
  }
  arm(args.dueMs)
  return {
    stop() {
      stopped = true
      if (handle !== null) {
        timers.clearTimeout(handle)
        handle = null
      }
    },
    running() {
      return !stopped
    },
  }
}
