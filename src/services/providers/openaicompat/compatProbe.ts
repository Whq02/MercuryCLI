import { createHash } from 'node:crypto'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { CompatEndpointSchema, type CompatEndpointSettings } from '../../../utils/settings/compatProvider.js'

export type CompatDialect = NonNullable<CompatEndpointSettings['dialect']>
export interface CompatServerReading {
  models: string[]
  contextWindows: Record<string, number>
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
      if (!response.ok) {
        await response.body?.cancel()
        return undefined
      }
      const body = record(await readJson(response))
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

export async function probeLlamacppSlot(
  endpoint: CompatEndpointSettings & { baseUrl: string },
  slotId: number,
  opts: { key?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ alive: boolean; words: string }> {
  const controller = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), LLAMACPP_SLOT_PROBE_MS)
  timer.unref?.()
  let server = 'the llama.cpp server'
  try {
    const root = compatServerBase(endpoint.baseUrl).replace(/\/v1$/, '')
    server = `the llama.cpp server at ${root}`
    const read = async (path: string): Promise<{ status: number; body?: unknown }> => {
      const response = await (opts.fetchImpl ?? getApiFetch())(`${root}${path}`, {
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
      if (!response.ok) {
        await response.body?.cancel()
        return { status: response.status }
      }
      try {
        return { status: response.status, body: await readJson(response) }
      } catch (error) {
        if (signal.aborted) throw error
        return { status: response.status }
      }
    }
    let answer = await read('/slots')
    if (answer.body === undefined) {
      const legacy = await read('/health?include_slots=1')
      const slots = record(legacy.body)?.slots
      if (Array.isArray(slots)) answer = { status: legacy.status, body: slots }
    }
    if (answer.body === undefined) return { alive: false, words: `${server} answered GET /slots with HTTP ${answer.status}, so slot ${slotId} cannot be read` }
    const list = Array.isArray(answer.body) ? answer.body.map(record) : []
    if (list.length === 0) return { alive: false, words: `${server} answered GET /slots without a slot list` }
    const slot = slotId % list.length
    const row = list.find(entry => entry?.id === slot)
    if (row === undefined) return { alive: false, words: `${server} lists no slot ${slot}` }
    return row.is_processing === true
      ? { alive: true, words: `${server} reports slot ${slot} processing` }
      : { alive: false, words: `${server} reports slot ${slot} idle: nothing on the server is working on this request` }
  } catch (error) {
    const timedOut = controller.signal.aborted && opts.signal?.aborted !== true
    return {
      alive: false,
      words: timedOut
        ? `${server} did not answer GET /slots within ${LLAMACPP_SLOT_PROBE_MS / 1000} s`
        : `${server} could not be reached for GET /slots (${error instanceof Error ? error.message : String(error)})`,
    }
  } finally {
    clearTimeout(timer)
  }
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
    for (const value of rows) {
      const row = record(value)!
      const tokens = windowTokens(row.max_model_len) ?? windowTokens(row.context_length)
      if (tokens) contextWindows[row.id.trim()] = tokens
    }
    const [sglang, llama, ollama] = await Promise.all([
      opts.detect || endpoint.dialect === 'sglang' ? optional('/get_model_info') : undefined,
      opts.detect || endpoint.dialect === 'llamacpp' ? optional('/props') : undefined,
      opts.detect || endpoint.dialect === 'ollama' ? optional('/api/tags') : undefined,
    ])
    const detected: CompatDialect | undefined = typeof sglang?.model_path === 'string' && windowTokens(sglang.context_length) ? 'sglang'
      : record(llama?.default_generation_settings) ? 'llamacpp'
      : Array.isArray(ollama?.models) ? 'ollama'
      : rows.some(row => record(row)?.owned_by === 'sglang') ? 'sglang'
      : rows.some(row => record(row)?.owned_by === 'vllm' || windowTokens(record(row)?.max_model_len)) ? 'vllm' : undefined
    const dialect = endpoint.dialect ?? detected
    if (dialect === 'sglang') {
      const tokens = windowTokens(sglang?.context_length)
      if (tokens) for (const id of models) if (models.length === 1 || id === sglang?.model_path || id === sglang?.served_model_name) contextWindows[id] = tokens
    }
    if (dialect === 'llamacpp') {
      const slots = windowTokens(llama?.total_slots)
      if (slots !== undefined) llamacppSlotsCache.set(llamacppEndpointKey(endpoint), slots)
      if (models.length === 1) {
        const tokens = windowTokens(llama?.default_generation_settings?.n_ctx)
        if (tokens) contextWindows[models[0]!] = tokens
      }
    }
    if (dialect === 'ollama') {
      const ps = await optional('/api/ps')
      for (const id of models) {
        const served = Array.isArray(ps?.models) ? ps.models.find((row: any) => row.name === id || row.model === id) : undefined
        let tokens = windowTokens(served?.context_length)
        if (!tokens) {
          const info = await optional('/api/show', { model: id })
          const explicit = typeof info?.parameters === 'string' ? info.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1] : undefined
          tokens = explicit ? windowTokens(Number(explicit)) : undefined
        }
        if (tokens) contextWindows[id] = tokens
      }
    }
    if (signal.aborted) throw new Error('Server discovery cancelled or timed out.')
    return { models, contextWindows, ...(detected ? { dialect: detected } : {}) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CompatProbeError(opts.key ? detail.split(opts.key).join('[redacted]') : detail, error instanceof CompatProbeError ? error.status : undefined)
  } finally { clearTimeout(timer) }
}
