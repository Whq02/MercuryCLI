import { isDeepStrictEqual } from 'node:util'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { getApiFetch } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import type { LocalServerKind } from '../openaicompat/compatWire.js'
import { kvGeometryOf, type KvGeometry } from '../../localServer/localServerMemory.js'
import { resolveLocalApiKey } from './localAccounts.js'

export type { LocalServerKind }

export const DEFAULT_LOCAL_PROBE_TARGETS: readonly { kind: LocalServerKind; root: string }[] = [
  { kind: 'ollama', root: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio', root: 'http://127.0.0.1:1234' },
  { kind: 'vllm', root: 'http://127.0.0.1:8000' },
  { kind: 'llamacpp', root: 'http://127.0.0.1:8080' },
]

export const LOCAL_PROBE_TIMEOUT_MS = 900
export const LOCAL_LOAD_TIMEOUT_MS = 180_000
const OLLAMA_SHOW_BOUND = 32

export type LocalContextSource = 'served' | 'modelfile' | 'model-max'

export interface LocalModelRecord {
  id: string
  displayName?: string
  server: LocalServerKind
  baseUrl: string
  contextWindow?: { tokens: number; source: LocalContextSource }
  modelMaxContext?: number
  toolsDeclared?: boolean
  thinkingDeclared?: boolean
  visionDeclared?: boolean
  loaded?: boolean
  family?: string
  parameterSize?: string
  quantization?: string
  servedReadAtMs?: number
  weightsBytes?: number
  geometry?: KvGeometry
}

export interface LocalServerRecord {
  kind: LocalServerKind
  root: string
  baseUrl: string
  label: string
  version?: string
  models: LocalModelRecord[]
}

export interface LocalDiscoverySnapshot {
  servers: LocalServerRecord[]
  probedAtMs: number
  targetCount: number
}

export interface LocalDiscoveryIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  loadTimeoutMs?: number
  signal?: AbortSignal
}

const KINDS: readonly LocalServerKind[] = ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'openai-compatible']
function isKind(v: string): v is LocalServerKind {
  return (KINDS as readonly string[]).includes(v)
}

export function localProbeTargets(
  env: NodeJS.ProcessEnv = process.env,
): { kind: LocalServerKind; root: string }[] {
  const pinned = env['MERCURY_LOCAL_PROBE_TARGETS']?.trim()
  let targets: { kind: LocalServerKind; root: string }[]
  if (pinned === undefined || pinned === '') {
    targets = [...DEFAULT_LOCAL_PROBE_TARGETS]
  } else if (pinned.toLowerCase() === 'none') {
    targets = []
  } else {
    targets = []
    for (const entry of pinned.split(',')) {
      const [kindRaw, ...rest] = entry.split('=')
      const kind = (kindRaw ?? '').trim().toLowerCase()
      const root = rest.join('=').trim().replace(/\/+$/, '')
      if (isKind(kind) && root) targets.push({ kind, root })
    }
  }
  const override = env['MERCURY_LOCAL_BASE_URL']?.trim()
  if (override) {
    const root = override.replace(/\/+$/, '').replace(/\/v1$/, '')
    if (!targets.some(t => t.root === root)) targets.push({ kind: 'openai-compatible', root })
  }
  return targets
}


async function probeJson(
  url: string,
  io: LocalDiscoveryIo,
  init?: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
): Promise<unknown | undefined> {
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const timeoutMs = init?.timeoutMs ?? io.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS
  const key = resolveLocalApiKey(io.env ?? process.env)
  try {
    const response = await fetchWithProviderDeadline(fetchImpl, 'local', timeoutMs, url, {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': getUserAgent(),
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { authorization: `Bearer ${key.key}` } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(io.signal !== undefined ? { signal: io.signal } : {}),
    } as RequestInit)
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}
function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
}
function parameterSizeWords(params: number): string {
  return params >= 1e9 ? `${(params / 1e9).toFixed(1)}B` : `${Math.round(params / 1e6)}M`
}


function ollamaServedMap(psBody: unknown): Map<string, number> {
  const served = new Map<string, number>()
  for (const loaded of (Array.isArray(rec(psBody)?.models) ? (rec(psBody)!.models as unknown[]) : [])) {
    const l = rec(loaded)
    const name = str(l?.model) ?? str(l?.name)
    const ctx = num(l?.context_length)
    if (name && ctx) served.set(name, ctx)
  }
  return served
}

export async function probeOllama(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const tags = rec(await probeJson(`${root}/api/tags`, io))
  if (!tags || !Array.isArray(tags.models)) return undefined
  const [versionBody, psBody] = await Promise.all([
    probeJson(`${root}/api/version`, io),
    probeJson(`${root}/api/ps`, io),
  ])
  const version = str(rec(versionBody)?.version)
  const served = ollamaServedMap(psBody)
  const listed = (tags.models as unknown[]).map(rec).filter((m): m is Record<string, unknown> => m !== undefined)
  const baseUrl = `${root}/v1`
  const models = await Promise.all(
    listed.slice(0, OLLAMA_SHOW_BOUND).map(async (m): Promise<LocalModelRecord | undefined> => {
      const id = str(m.model) ?? str(m.name)
      if (!id) return undefined
      const details = rec(m.details)
      const show = rec(await probeJson(`${root}/api/show`, io, { method: 'POST', body: { model: id } }))
      const capabilities = strList(show?.capabilities) ?? strList(m.capabilities)
      const info = rec(show?.model_info)
      const arch = str(info?.['general.architecture'])
      const modelMax = arch ? num(info?.[`${arch}.context_length`]) : undefined
      const params = str(show?.parameters)
      const numCtx = params ? num(Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(params)?.[1])) : undefined
      const servedCtx = served.get(id)
      const contextWindow: LocalModelRecord['contextWindow'] = servedCtx
        ? { tokens: servedCtx, source: 'served' }
        : numCtx
          ? { tokens: numCtx, source: 'modelfile' }
          : undefined
      const weightsBytes = num(m.size)
      const geometry = info ? kvGeometryOf(info) : undefined
      return {
        id,
        server: 'ollama',
        baseUrl,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(modelMax !== undefined ? { modelMaxContext: modelMax } : {}),
        ...(weightsBytes !== undefined ? { weightsBytes } : {}),
        ...(geometry !== undefined ? { geometry } : {}),
        ...(capabilities
          ? {
              toolsDeclared: capabilities.includes('tools'),
              thinkingDeclared: capabilities.includes('thinking'),
              visionDeclared: capabilities.includes('vision'),
            }
          : {}),
        loaded: served.has(id),
        ...(str(details?.family) ? { family: str(details?.family)! } : {}),
        ...(str(details?.parameter_size) ? { parameterSize: str(details?.parameter_size)! } : {}),
        ...(str(details?.quantization_level) ? { quantization: str(details?.quantization_level)! } : {}),
      }
    }),
  )
  return {
    kind: 'ollama',
    root,
    baseUrl,
    label: version ? `Ollama ${version}` : 'Ollama',
    ...(version ? { version } : {}),
    models: models.filter((m): m is LocalModelRecord => m !== undefined),
  }
}


export async function probeLmStudio(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const baseUrl = `${root}/v1`
  const v1 = rec(await probeJson(`${root}/api/v1/models`, io))
  if (v1 && Array.isArray(v1.models)) {
    const models: LocalModelRecord[] = []
    for (const raw of v1.models as unknown[]) {
      const m = rec(raw)
      const id = str(m?.key)
      if (!m || !id) continue
      if (str(m.type) === 'embedding') continue
      const instances = Array.isArray(m.loaded_instances) ? (m.loaded_instances as unknown[]).map(rec) : []
      const servedCtx = instances.map(i => num(rec(i?.config)?.context_length)).find((n): n is number => n !== undefined)
      const modelMax = num(m.max_context_length)
      const caps = rec(m.capabilities)
      const quant = rec(m.quantization)
      models.push({
        id,
        ...(str(m.display_name) ? { displayName: str(m.display_name)! } : {}),
        server: 'lmstudio',
        baseUrl,
        ...(servedCtx
          ? { contextWindow: { tokens: servedCtx, source: 'served' } }
          : modelMax
            ? { contextWindow: { tokens: modelMax, source: 'model-max' } }
            : {}),
        ...(modelMax !== undefined ? { modelMaxContext: modelMax } : {}),
        ...(num(m.size_bytes) !== undefined ? { weightsBytes: num(m.size_bytes)! } : {}),
        ...(typeof caps?.trained_for_tool_use === 'boolean' ? { toolsDeclared: caps.trained_for_tool_use } : {}),
        ...(typeof caps?.vision === 'boolean' ? { visionDeclared: caps.vision } : {}),
        ...(rec(m.reasoning) ? { thinkingDeclared: true } : {}),
        loaded: instances.length > 0,
        ...(str(m.architecture) ? { family: str(m.architecture)! } : {}),
        ...(str(m.params_string) ? { parameterSize: str(m.params_string)! } : {}),
        ...(str(quant?.name) ? { quantization: str(quant?.name)! } : {}),
      })
    }
    return { kind: 'lmstudio', root, baseUrl, label: 'LM Studio', models }
  }
  const v0 = rec(await probeJson(`${root}/api/v0/models`, io))
  if (v0 && Array.isArray(v0.data)) {
    const models: LocalModelRecord[] = []
    for (const raw of v0.data as unknown[]) {
      const m = rec(raw)
      const id = str(m?.id)
      if (!m || !id) continue
      if (str(m.type) === 'embeddings') continue
      const modelMax = num(m.max_context_length)
      models.push({
        id,
        server: 'lmstudio',
        baseUrl,
        ...(modelMax ? { contextWindow: { tokens: modelMax, source: 'model-max' }, modelMaxContext: modelMax } : {}),
        ...(str(m.state) ? { loaded: str(m.state) === 'loaded' } : {}),
        ...(str(m.arch) ? { family: str(m.arch)! } : {}),
        ...(str(m.quantization) ? { quantization: str(m.quantization)! } : {}),
      })
    }
    return { kind: 'lmstudio', root, baseUrl, label: 'LM Studio', models }
  }
  return undefined
}


function openaiModelList(body: unknown): Record<string, unknown>[] | undefined {
  const o = rec(body)
  if (!o || !Array.isArray(o.data)) return undefined
  return (o.data as unknown[]).map(rec).filter((m): m is Record<string, unknown> => m !== undefined)
}

export async function probeVllm(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const list = openaiModelList(await probeJson(`${root}/v1/models`, io))
  if (!list) return undefined
  const baseUrl = `${root}/v1`
  const models: LocalModelRecord[] = []
  for (const m of list) {
    const id = str(m.id)
    if (!id) continue
    const served = num(m.max_model_len)
    models.push({
      id,
      server: 'vllm',
      baseUrl,
      ...(served ? { contextWindow: { tokens: served, source: 'served' } } : {}),
    })
  }
  return { kind: 'vllm', root, baseUrl, label: 'vLLM', models }
}


export async function probeLlamaCpp(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const [v1Body, propsBody, routerBody] = await Promise.all([
    probeJson(`${root}/v1/models`, io),
    probeJson(`${root}/props`, io),
    probeJson(`${root}/models`, io),
  ])
  const list = openaiModelList(v1Body)
  const props = rec(propsBody)
  if (!list && !props) return undefined
  const baseUrl = `${root}/v1`
  const servedCtx = num(rec(props?.default_generation_settings)?.n_ctx)
  const vision = typeof rec(props?.modalities)?.vision === 'boolean' ? (rec(props?.modalities)!.vision as boolean) : undefined
  const build = str(props?.build_info)
  const models: LocalModelRecord[] = []
  const routerRows = (openaiModelList(routerBody) ?? []).filter(m => rec(m.status) !== undefined)
  if (routerRows.length > 0) {
    for (const m of routerRows) {
      const id = str(m.id)
      if (!id) continue
      const status = str(rec(m.status)?.value)
      const loaded = status === 'loaded'
      models.push({
        id,
        server: 'llamacpp',
        baseUrl,
        ...(loaded && servedCtx ? { contextWindow: { tokens: servedCtx, source: 'served' } } : {}),
        ...(status ? { loaded } : {}),
        ...(vision !== undefined ? { visionDeclared: vision } : {}),
      })
    }
  } else if (list) {
    for (const m of list) {
      const id = str(m.id)
      if (!id) continue
      const meta = rec(m.meta)
      const served = servedCtx ?? num(meta?.n_ctx)
      const trained = num(meta?.n_ctx_train)
      const weightsBytes = num(meta?.size)
      const params = num(meta?.n_params)
      models.push({
        id,
        server: 'llamacpp',
        baseUrl,
        ...(served
          ? { contextWindow: { tokens: served, source: 'served' } }
          : trained
            ? { contextWindow: { tokens: trained, source: 'model-max' } }
            : {}),
        ...(trained !== undefined ? { modelMaxContext: trained } : {}),
        ...(weightsBytes !== undefined ? { weightsBytes } : {}),
        ...(params !== undefined ? { parameterSize: parameterSizeWords(params) } : {}),
        loaded: meta !== undefined,
        ...(vision !== undefined ? { visionDeclared: vision } : {}),
      })
    }
  }
  return {
    kind: 'llamacpp',
    root,
    baseUrl,
    label: build ? `llama.cpp ${build}` : 'llama.cpp',
    ...(build ? { version: build } : {}),
    models,
  }
}


export async function probeOpenaiCompatible(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const ollama = await probeOllama(root, io)
  if (ollama) return ollama
  const lmstudio = await probeLmStudio(root, io)
  if (lmstudio) return lmstudio
  const llamacpp = rec(await probeJson(`${root}/props`, io)) ? await probeLlamaCpp(root, io) : undefined
  if (llamacpp) return llamacpp
  const list = openaiModelList(await probeJson(`${root}/v1/models`, io))
  if (!list) return undefined
  if (list.some(m => str(m.owned_by) === 'vllm' || num(m.max_model_len) !== undefined)) return probeVllm(root, io)
  if (list.some(m => str(m.owned_by) === 'llamacpp')) return probeLlamaCpp(root, io)
  const baseUrl = `${root}/v1`
  const models: LocalModelRecord[] = []
  for (const m of list) {
    const id = str(m.id)
    if (id) models.push({ id, server: 'openai-compatible', baseUrl })
  }
  return { kind: 'openai-compatible', root, baseUrl, label: 'OpenAI-compatible server', models }
}

async function probeTarget(target: { kind: LocalServerKind; root: string }, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  switch (target.kind) {
    case 'ollama':
      return probeOllama(target.root, io)
    case 'lmstudio':
      return probeLmStudio(target.root, io)
    case 'vllm':
      return probeVllm(target.root, io)
    case 'llamacpp':
      return probeLlamaCpp(target.root, io)
    case 'openai-compatible':
      return probeOpenaiCompatible(target.root, io)
  }
}

export async function discoverLocalServers(io: LocalDiscoveryIo = {}): Promise<LocalDiscoverySnapshot> {
  const env = io.env ?? process.env
  const targets = localProbeTargets(env)
  const results = await Promise.all(targets.map(t => probeTarget(t, io).catch(() => undefined)))
  const servers = results.filter((s): s is LocalServerRecord => s !== undefined)
  return { servers, probedAtMs: io.now?.() ?? Date.now(), targetCount: targets.length }
}


export const LOCAL_DISCOVERY_TTL_MS = 60_000

let cached: LocalDiscoverySnapshot | null = null
let inFlight: Promise<LocalDiscoverySnapshot> | null = null

export function getCachedLocalDiscovery(): LocalDiscoverySnapshot | null {
  return cached
}

export function refreshLocalDiscovery(opts?: LocalDiscoveryIo & { force?: boolean }): Promise<LocalDiscoverySnapshot> {
  const now = opts?.now ?? Date.now
  if (!opts?.force && cached && now() - cached.probedAtMs < LOCAL_DISCOVERY_TTL_MS) return Promise.resolve(cached)
  if (inFlight) return inFlight
  const { force: _force, ...io } = opts ?? {}
  inFlight = (async (): Promise<LocalDiscoverySnapshot> => {
    try {
      const before = cached
      const snapshot = await discoverLocalServers(io)
      cached = snapshot
      if (before === null || before.targetCount !== snapshot.targetCount || !isDeepStrictEqual(before.servers, snapshot.servers)) {
        bumpCatalogueEpoch()
      }
      return snapshot
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function cachedLocalModels(): LocalModelRecord[] {
  return cached ? cached.servers.flatMap(s => s.models) : []
}

export function localModelRecord(wireId: string): LocalModelRecord | undefined {
  const lower = wireId.trim().toLowerCase()
  const slash = lower.indexOf('/')
  if (slash > 0) {
    const kind = lower.slice(0, slash)
    if ((KINDS as readonly string[]).includes(kind)) {
      const rest = lower.slice(slash + 1)
      const qualified = cachedLocalModels().find(m => m.server === kind && m.id.toLowerCase() === rest)
      if (qualified) return qualified
    }
  }
  return cachedLocalModels().find(m => m.id.toLowerCase() === lower)
}

export function localServerFor(model: LocalModelRecord): LocalServerRecord | undefined {
  return cached?.servers.find(s => s.baseUrl === model.baseUrl && s.kind === model.server)
}

export interface ServedWindowLoad {
  numCtx?: number
  probeOnly?: boolean
}

function servedFrom(server: LocalServerRecord | undefined, id: string): number | undefined {
  const model = server?.models.find(m => m.id === id)
  return model?.contextWindow?.source === 'served' ? model.contextWindow.tokens : undefined
}

async function loadOllama(root: string, id: string, io: LocalDiscoveryIo, load?: ServedWindowLoad): Promise<number | undefined> {
  const loadTimeoutMs = io.loadTimeoutMs ?? LOCAL_LOAD_TIMEOUT_MS
  if (load?.probeOnly !== true) {
    await probeJson(`${root}/api/generate`, io, {
      method: 'POST',
      timeoutMs: loadTimeoutMs,
      body: { model: id, ...(load?.numCtx !== undefined ? { options: { num_ctx: load.numCtx } } : {}) },
    })
  }
  return ollamaServedMap(await probeJson(`${root}/api/ps`, io)).get(id)
}

async function loadLmStudio(root: string, id: string, io: LocalDiscoveryIo, load?: ServedWindowLoad): Promise<number | undefined> {
  const before = await probeLmStudio(root, io)
  const served = servedFrom(before, id)
  if (load?.numCtx === undefined) return served
  if (served === load.numCtx) return served
  const loadTimeoutMs = io.loadTimeoutMs ?? LOCAL_LOAD_TIMEOUT_MS
  const v1 = rec(await probeJson(`${root}/api/v1/models`, io))
  const entry = (Array.isArray(v1?.models) ? (v1!.models as unknown[]).map(rec) : []).find(m => str(m?.key) === id)
  const instances = Array.isArray(entry?.loaded_instances) ? (entry!.loaded_instances as unknown[]).map(rec) : []
  for (const instance of instances) {
    const instanceId = str(instance?.id)
    if (instanceId) await probeJson(`${root}/api/v1/models/unload`, io, { method: 'POST', body: { instance_id: instanceId } })
  }
  await probeJson(`${root}/api/v1/models/load`, io, { method: 'POST', timeoutMs: loadTimeoutMs, body: { model: id, context_length: load.numCtx } })
  return servedFrom(await probeLmStudio(root, io), id)
}

export async function readServedWindow(record: LocalModelRecord, io: LocalDiscoveryIo = {}, load?: ServedWindowLoad): Promise<number | undefined> {
  const root = record.baseUrl.replace(/\/v1$/, '')
  try {
    switch (record.server) {
      case 'ollama':
        return await loadOllama(root, record.id, io, load)
      case 'lmstudio':
        return await loadLmStudio(root, record.id, io, load)
      case 'vllm':
        return servedFrom(await probeVllm(root, io), record.id)
      case 'llamacpp':
        return servedFrom(await probeLlamaCpp(root, io), record.id)
      case 'openai-compatible':
        return undefined
    }
  } catch {
    return undefined
  }
}

export function servedWindowIsCurrent(record: LocalModelRecord, now: number = Date.now()): boolean {
  if (record.contextWindow?.source !== 'served') return false
  const readAt = Math.max(cached?.probedAtMs ?? 0, record.servedReadAtMs ?? 0)
  return now - readAt < LOCAL_DISCOVERY_TTL_MS
}

function noteServedWindow(record: LocalModelRecord, tokens: number, now: number): void {
  const before = record.contextWindow
  record.contextWindow = { tokens, source: 'served' }
  record.loaded = true
  record.servedReadAtMs = now
  if (before?.source !== 'served' || before.tokens !== tokens) bumpCatalogueEpoch()
}

export async function ensureServedWindow(record: LocalModelRecord, io: LocalDiscoveryIo = {}, load?: ServedWindowLoad): Promise<LocalModelRecord> {
  const now = io.now?.() ?? Date.now()
  const current = servedWindowIsCurrent(record, now)
  if (current && (load?.numCtx === undefined || record.contextWindow?.tokens === load.numCtx)) return record
  const tokens = await readServedWindow(record, io, load)
  if (tokens === undefined) return record
  noteServedWindow(record, tokens, now)
  return record
}

export async function confirmServedWindow(record: LocalModelRecord, io: LocalDiscoveryIo = {}): Promise<number | undefined> {
  const now = io.now?.() ?? Date.now()
  const tokens = await readServedWindow(record, io, { probeOnly: true })
  if (tokens !== undefined) noteServedWindow(record, tokens, now)
  return tokens
}

export function __resetLocalDiscoveryForTest(): void {
  cached = null
  inFlight = null
}
