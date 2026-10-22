import { createHash } from 'node:crypto'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
import { deepestErrorDetail, isStaleSocketCode } from '../../api/transportEvidence.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { CompatEndpointSchema, type CompatEndpointSettings } from '../../../utils/settings/compatProvider.js'
import type { CompatLivenessReading } from './compatChatClient.js'
import { compatModelEndpoint, resolveCompatApiKey } from './compatAccounts.js'

export type CompatDialect = NonNullable<CompatEndpointSettings['dialect']>
export interface CompatServerReading {
  models: string[]
  contextWindows: Record<string, number>
  efforts?: Record<string, string[]>
  capabilities?: Record<string, { images?: boolean; tools?: boolean; reasoning?: boolean }>
  dialect?: CompatDialect
}

export class CompatProbeError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const record = (value: unknown): Record<string, any> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
const windowTokens = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
const llamacppSlotsCache = new Map<string, number>()
const llamacppSlotsInFlight = new Map<string, Promise<number | undefined>>()
const llamacppSlotHolders = new Map<string, Map<string, { slot: number; crewmate: boolean }>>()
const LLAMACPP_SLOT_HOLDERS_KEPT = 64
const LLAMACPP_SLOT_PROBE_MS = 5_000


type CompatImageReading = { supported: boolean; source: 'projector' | 'model' }
const serverImages = new Map<string, { projector?: boolean; models: NonNullable<CompatServerReading['capabilities']> }>()

function rememberProjector(endpoint: CompatEndpointSettings & { baseUrl: string }, body: Record<string, any> | undefined): boolean | undefined {
  const key = compatServerBase(endpoint.baseUrl)
  const vision = body?.modalities?.vision
  const projector = typeof vision === 'boolean' ? vision : undefined
  serverImages.set(key, { models: {}, ...(projector !== undefined ? { projector } : {}) })
  return projector
}

export function compatModelImageReading(model: string): CompatImageReading | undefined {
  const resolved = compatModelEndpoint(model)
  if (!resolved) return undefined
  const reading = serverImages.get(compatServerBase(resolved.endpoint.baseUrl))
  if (resolved.endpoint.dialect === 'llamacpp' && reading?.projector !== undefined) return { supported: reading.projector, source: 'projector' }
  const supported = reading?.models[resolved.wireId]?.images
  return supported === undefined ? undefined : { supported, source: 'model' }
}

export async function refreshCompatModelImageReading(model: string, signal?: AbortSignal): Promise<void> {
  const resolved = compatModelEndpoint(model)
  if (resolved?.endpoint.dialect !== 'llamacpp') return
  invalidateLlamacppTotalSlots(resolved.endpoint)
  await resolveLlamacppTotalSlots(resolved.endpoint, { key: resolveCompatApiKey(process.env, resolved.endpoint.name)?.key, signal })
}

export function compatImageRefusalWords(model: string, error?: string): string | null {
  const reading = compatModelImageReading(model)
  if ((reading?.source === 'projector' && !reading.supported) || (compatModelEndpoint(model)?.endpoint.dialect === 'llamacpp' && /mmproj|vision projector/i.test(error ?? ''))) {
    return `this server runs ${model} without its vision projector — rent it again with the recipe that carries one (/llmhost), or start the server with --mmproj`
  }
  return reading?.supported === false ? `this model receives text only on this server: ${model} — /model picks one that receives images` : null
}
function llamacppEndpointKey(endpoint: CompatEndpointSettings & { name?: string; baseUrl: string }): string {
  return `${endpoint.name ?? 'default'}:${compatServerBase(endpoint.baseUrl)}`
}

export function assignLlamacppSlot(
  endpoint: CompatEndpointSettings & { name?: string; baseUrl: string },
  conversationKey: string,
  totalSlots: number,
  crewmate: boolean,
): number {
  const endpointKey = llamacppEndpointKey(endpoint)
  let holders = llamacppSlotHolders.get(endpointKey)
  if (holders === undefined) {
    holders = new Map()
    llamacppSlotHolders.set(endpointKey, holders)
  }
  const held = holders.get(conversationKey)
  holders.delete(conversationKey)
  let slot = held !== undefined && held.slot < totalSlots ? held.slot : undefined
  if (slot === undefined) {
    const taken = new Set<number>()
    for (const holder of holders.values()) if (holder.slot < totalSlots) taken.add(holder.slot)
    const preferred = createHash('sha256').update(conversationKey).digest().readUInt32BE(0) % totalSlots
    for (let step = 0; step < totalSlots && slot === undefined; step++) {
      const candidate = (preferred + step) % totalSlots
      if (!taken.has(candidate)) slot = candidate
    }
    if (slot === undefined) {
      let victim: string | undefined
      let victimIsCrewmate = false
      for (const [key, holder] of holders) {
        if (holder.slot >= totalSlots) continue
        if (victim === undefined || (!victimIsCrewmate && holder.crewmate)) {
          victim = key
          victimIsCrewmate = holder.crewmate
          slot = holder.slot
        }
        if (victimIsCrewmate) break
      }
      if (victim !== undefined) holders.delete(victim)
    }
  }
  const assigned = slot ?? 0
  holders.set(conversationKey, { slot: assigned, crewmate: crewmate && held?.crewmate !== false })
  while (holders.size > LLAMACPP_SLOT_HOLDERS_KEPT) holders.delete(holders.keys().next().value!)
  return assigned
}

export function invalidateLlamacppTotalSlots(endpoint: CompatEndpointSettings & { name?: string; baseUrl: string }): void {
  try { serverImages.delete(compatServerBase(endpoint.baseUrl)) } catch {}
  try { llamacppSlotsCache.delete(llamacppEndpointKey(endpoint)) } catch {}
}

export async function resolveLlamacppTotalSlots(
  endpoint: CompatEndpointSettings & { name?: string; baseUrl: string },
  opts: { key?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<number | undefined> {
  let cacheKey: string
  try { cacheKey = llamacppEndpointKey(endpoint) } catch { return undefined }
  const cached = llamacppSlotsCache.get(cacheKey)
  if (cached !== undefined) return cached
  const pending = llamacppSlotsInFlight.get(cacheKey)
  if (pending) return pending
  const work = (async (): Promise<number | undefined> => {
    const controller = new AbortController()
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
    const timer = setTimeout(() => controller.abort(), 5_000)
    timer.unref?.()
    try {
      const root = compatServerBase(endpoint.baseUrl).replace(/\/v1$/, '')
      const response = await (opts.fetchImpl ?? getApiFetch())(`${root}/props`, {
        ...getProxyFetchOptions(),
        method: 'GET',
        headers: {
          ...endpoint.headers,
          accept: 'application/json',
          'user-agent': getUserAgent(),
          ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        },
        signal,
        redirect: 'error',
      } as RequestInit)
      rememberProjector(endpoint, undefined)
      if (!response.ok) {
        await response.body?.cancel()
        return undefined
      }
      const body = record(await readJson(response))
      rememberProjector(endpoint, body)
      const totalSlots = windowTokens(body?.total_slots)
      if (totalSlots !== undefined) llamacppSlotsCache.set(cacheKey, totalSlots)
      return totalSlots
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
      llamacppSlotsInFlight.delete(cacheKey)
    }
  })()
  llamacppSlotsInFlight.set(cacheKey, work)
  return work
}

type LivenessAnswer =
  | { kind: 'answer'; status: number; body?: unknown }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; words: string }
  | { kind: 'reset'; words: string }
  | { kind: 'error'; words: string }

const SELF_HOSTED_NAMES: Readonly<Record<string, string>> = { llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang', ollama: 'Ollama', lmstudio: 'LM Studio' }

export async function readSelfHostedLiveness(
  endpoint: CompatEndpointSettings & { baseUrl: string },
  dialect: string,
  pinnedSlot: number | undefined,
  opts: { key?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CompatLivenessReading> {
  const name = `the ${SELF_HOSTED_NAMES[dialect] ?? 'self-hosted'} server`
  let base: string
  try {
    base = compatServerBase(endpoint.baseUrl)
  } catch {
    return { state: 'unknown', answered: false, words: `${name} has no readable address` }
  }
  const root = base.replace(/\/v1$/, '')
  const server = `${name} at ${root}`
  const attempt = async (url: string, json: boolean): Promise<LivenessAnswer> => {
    const controller = new AbortController()
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
    const timer = setTimeout(() => controller.abort(), LLAMACPP_SLOT_PROBE_MS)
    timer.unref?.()
    try {
      const response = await (opts.fetchImpl ?? getApiFetch())(url, {
        ...getProxyFetchOptions(),
        method: 'GET',
        headers: {
          ...endpoint.headers,
          accept: 'application/json',
          'user-agent': getUserAgent(),
          ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        },
        signal,
        redirect: 'error',
      } as RequestInit)
      if (!json || !response.ok) {
        await response.body?.cancel()
        return { kind: 'answer', status: response.status }
      }
      try {
        return { kind: 'answer', status: response.status, body: await readJson(response) }
      } catch (error) {
        if (signal.aborted) throw error
        return { kind: 'answer', status: response.status }
      }
    } catch (error) {
      if (controller.signal.aborted && opts.signal?.aborted !== true) return { kind: 'timeout' }
      const outage = outageCauseOfFetchFailure(error)
      if (outage !== null) return outage.words === 'connect timed out' ? { kind: 'timeout' } : { kind: 'unreachable', words: outage.words }
      const deep = deepestErrorDetail(error)
      if (isStaleSocketCode(deep.code)) return { kind: 'reset', words: deep.code ?? deep.message }
      return { kind: 'error', words: deep.message }
    } finally {
      clearTimeout(timer)
    }
  }
  const ask = async (url: string, json: boolean): Promise<LivenessAnswer> => {
    const first = await attempt(url, json)
    return first.kind === 'reset' ? attempt(url, json) : first
  }
  const unanswered = (answer: Exclude<LivenessAnswer, { kind: 'answer' }>, read: string): CompatLivenessReading => {
    switch (answer.kind) {
      case 'timeout':
        return { state: 'unknown', answered: false, words: `${server} did not answer ${read} within ${LLAMACPP_SLOT_PROBE_MS / 1000} s` }
      case 'unreachable':
        return { state: 'dead', answered: false, words: `${server} could not be reached for ${read} (${answer.words})` }
      case 'reset':
        return { state: 'dead', answered: false, words: `${server} reset the connection twice for ${read} (${answer.words})` }
      case 'error':
        return { state: 'unknown', answered: false, words: `${server} could not be read with ${read} (${answer.words})` }
    }
  }
  if (dialect === 'llamacpp' && pinnedSlot !== undefined) {
    let answer = await ask(`${root}/slots`, true)
    if (answer.kind !== 'answer') return unanswered(answer, 'GET /slots')
    if (answer.body === undefined) {
      const legacy = await attempt(`${root}/health?include_slots=1`, true)
      const slots = legacy.kind === 'answer' ? record(legacy.body)?.slots : undefined
      if (Array.isArray(slots)) answer = { kind: 'answer', status: answer.status, body: slots }
    }
    if (answer.body === undefined) {
      return { state: 'unknown', answered: true, words: `${server} does not report slots (GET /slots answered HTTP ${answer.status}), so this silence runs to the idle budget` }
    }
    const list = Array.isArray(answer.body) ? answer.body.map(record) : []
    if (list.length === 0) return { state: 'unknown', answered: true, words: `${server} answered GET /slots without a slot list, so this silence runs to the idle budget` }
    const slot = pinnedSlot % list.length
    const row = list.find(entry => entry?.id === slot)
    if (row === undefined) return { state: 'unknown', answered: true, words: `${server} lists no slot ${slot}, so this silence runs to the idle budget` }
    return row.is_processing === true
      ? { state: 'working', answered: true, words: `${server} reports slot ${slot} processing` }
      : { state: 'dead', answered: true, words: `${server} reports slot ${slot} idle: nothing on the server is working on this request` }
  }
  const path = dialect === 'ollama' ? '/' : dialect === 'lmstudio' ? '/v1/models' : '/health'
  const answer = await ask(dialect === 'lmstudio' ? `${base}/models` : `${root}${path}`, false)
  if (answer.kind !== 'answer') return unanswered(answer, `GET ${path}`)
  return { state: 'alive', answered: true, words: `${server} answers GET ${path} (HTTP ${answer.status}): the process is up, though it does not say whether it is working on this request` }
}

export function compatServerBase(address: string): string {
  const base = address.trim().replace(/\/+$/, '')
  if (!CompatEndpointSchema().safeParse({ baseUrl: base }).success) throw new Error('Use an http(s) address without credentials, query or fragment.')
  const url = new URL(base)
  return url.pathname === '/' || url.pathname === '' ? `${base}/v1` : base
}

async function readJson(response: Response): Promise<unknown> {
  const ceiling = 4 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > ceiling) {
    await response.body?.cancel()
    throw new Error('models response exceeds 4194304 bytes')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('models endpoint returned no body')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > ceiling) throw new Error('models response exceeds 4194304 bytes')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('models endpoint returned invalid JSON') }
}

export async function inspectCompatServer(endpoint: CompatEndpointSettings & { baseUrl: string }, opts: { key?: string; fetchImpl?: typeof fetch; signal?: AbortSignal; detect?: boolean } = {}): Promise<CompatServerReading> {
  const base = compatServerBase(endpoint.baseUrl)
  const root = base.replace(/\/v1$/, '')
  const controller = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), 15_000)
  timer.unref?.()
  const request = async (url: string, body?: unknown): Promise<unknown> => {
    const response = await (opts.fetchImpl ?? getApiFetch())(url, {
      ...getProxyFetchOptions(),
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...endpoint.headers, accept: 'application/json', 'user-agent': getUserAgent(), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error',
    } as RequestInit)
    if (!response.ok) {
      await response.body?.cancel()
      throw new CompatProbeError(`models endpoint returned HTTP ${response.status}`, response.status)
    }
    return readJson(response)
  }
  const optional = async (path: string, body?: unknown): Promise<Record<string, any> | undefined> => {
    try { return record(await request(`${root}${path}`, body)) } catch { return undefined }
  }
  try {
    const body = record(await request(`${base}/models`))
    if (!Array.isArray(body?.data)) throw new Error('models endpoint returned no data array')
    const rows = body.data as unknown[]
    if (rows.some(row => typeof record(row)?.id !== 'string' || !record(row)!.id.trim())) throw new Error('models endpoint returned a row without a model id')
    const models = [...new Set(rows.map(row => record(row)!.id.trim() as string))]
    const contextWindows: Record<string, number> = Object.create(null)
    const efforts: Record<string, string[]> = Object.create(null)
    const capabilities: NonNullable<CompatServerReading['capabilities']> = Object.create(null)
    for (const value of rows) {
      const row = record(value)!
      const tokens = windowTokens(row.max_model_len) ?? windowTokens(row.context_length)
      if (tokens) contextWindows[row.id.trim()] = tokens
      const modalities = record(row.architecture)?.input_modalities ?? row.input_modalities
      if (Array.isArray(modalities) && modalities.length > 0 && modalities.every(value => typeof value === 'string')) capabilities[row.id.trim()] = { images: modalities.includes('image') }
    }
    const [sglang, llama, ollama] = await Promise.all([
      opts.detect || endpoint.dialect === 'sglang' ? optional('/get_model_info') : undefined,
      opts.detect || endpoint.dialect === 'llamacpp' ? optional('/props') : undefined,
      opts.detect || endpoint.dialect === 'ollama' ? optional('/api/tags') : undefined,
    ])
    const detected: CompatDialect | undefined = typeof sglang?.model_path === 'string' ? 'sglang'
      : record(llama?.default_generation_settings) ? 'llamacpp'
      : Array.isArray(ollama?.models) ? 'ollama'
      : rows.some(row => record(row)?.owned_by === 'sglang') ? 'sglang'
      : rows.some(row => record(row)?.owned_by === 'vllm' || windowTokens(record(row)?.max_model_len)) ? 'vllm' : undefined
    const dialect = endpoint.dialect ?? detected
    if (dialect === 'sglang') {
      const tokens = windowTokens(sglang?.context_length)
      if (tokens) for (const id of models) if (models.length === 1 || id === sglang?.model_path || id === sglang?.served_model_name) contextWindows[id] = tokens
      for (const id of models) {
        if (models.length !== 1 && id !== sglang?.model_path && id !== sglang?.served_model_name) continue
        const facts = {
          ...(typeof sglang?.has_image_understanding === 'boolean' ? { images: sglang.has_image_understanding } : {}),
          ...(typeof sglang?.tool_call_parser === 'string' || sglang?.tool_call_parser === null ? { tools: Boolean(sglang.tool_call_parser) } : {}),
          ...(typeof sglang?.reasoning_parser === 'string' || sglang?.reasoning_parser === null ? { reasoning: Boolean(sglang.reasoning_parser) } : {}),
        }
        if (Object.keys(facts).length) capabilities[id] = { ...capabilities[id], ...facts }
      }
    }
    if (dialect === 'llamacpp') {
      const vision = rememberProjector(endpoint, llama)
      if (models.length === 1 && vision !== undefined) capabilities[models[0]!] = { ...capabilities[models[0]!], images: vision }
      const slots = windowTokens(llama?.total_slots)
      if (slots !== undefined) llamacppSlotsCache.set(llamacppEndpointKey(endpoint), slots)
      if (models.length === 1) {
        const tokens = windowTokens(llama?.default_generation_settings?.n_ctx)
        if (tokens) contextWindows[models[0]!] = tokens
      }
    }
    if (dialect === 'llamacpp' && models.length === 1) {
      const caps = record(llama?.chat_template_caps)
      const tools = caps?.supports_tools === false || caps?.supports_tool_calls === false ? false
        : caps?.supports_tools === true && caps?.supports_tool_calls === true ? true : undefined
      const reasoning = caps?.supports_preserve_reasoning === true || caps?.supports_reasoning_effort === true ? true : undefined
      if (tools !== undefined || reasoning !== undefined) capabilities[models[0]!] = {
        ...capabilities[models[0]!],
        ...(tools !== undefined ? { tools } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
      }
    }
    if (dialect === 'ollama') {
      const ps = await optional('/api/ps')
      for (const id of models) {
        const served = Array.isArray(ps?.models) ? ps.models.find((row: any) => row.name === id || row.model === id) : undefined
        const info = await optional('/api/show', { model: id })
        efforts[id] = Array.isArray(info?.thinking?.values) ? info.thinking.values.filter((value: unknown): value is string => typeof value === 'string') : []
        if (Array.isArray(info?.capabilities)) capabilities[id] = {
          ...capabilities[id],
          images: info.capabilities.includes('vision'),
          tools: info.capabilities.includes('tools'),
          reasoning: info.capabilities.includes('thinking'),
        }
        let tokens = windowTokens(served?.context_length)
        if (!tokens) {
          const explicit = typeof info?.parameters === 'string' ? info.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1] : undefined
          tokens = explicit ? windowTokens(Number(explicit)) : undefined
        }
        if (tokens) contextWindows[id] = tokens
      }
    }
    if (signal.aborted) throw new Error('Server discovery cancelled or timed out.')
    serverImages.set(base, { ...(dialect === 'llamacpp' ? serverImages.get(base) : {}), models: capabilities })
    return { models, contextWindows, efforts, capabilities, ...(detected ? { dialect: detected } : {}) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CompatProbeError(opts.key ? detail.split(opts.key).join('[redacted]') : detail, error instanceof CompatProbeError ? error.status : undefined)
  } finally { clearTimeout(timer) }
}
