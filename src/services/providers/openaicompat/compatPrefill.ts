import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import type { CompatEndpointSettings } from '../../../utils/settings/compatProvider.js'
import { compatServerBase } from './compatProbe.js'

const readings = new Map<string, { at: number; speed: number | undefined }>()
const positive = (value: number): number | undefined => Number.isFinite(value) && value > 0 ? value : undefined

export function prefillSpeedFromMetrics(dialect: string, text: string, model: string): number | undefined {
  const values = new Map<string, Map<string, number>>()
  for (const line of text.split('\n')) {
    const row = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+([^\s]+)(?:\s+\S+)?\s*$/.exec(line)
    if (!row) continue
    const name = row[1]!
    if (dialect === 'llamacpp' && name !== 'llamacpp:prompt_tokens_seconds') continue
    if (dialect === 'sglang' && !['sglang:prompt_tokens_total', 'sglang:time_to_first_token_seconds_sum'].includes(name)) continue
    const labels = [...(row[2] ?? '').matchAll(/(\w+)="((?:\\.|[^"\\])*)"/g)].map(match => [match[1]!, JSON.parse(`"${match[2]}"`) as string] as const)
    const modelName = labels.find(([key]) => key === 'model_name' || key === 'model')?.[1]
    if (dialect === 'sglang' && modelName !== model || modelName !== undefined && modelName !== model) continue
    const value = positive(Number(row[3]))
    if (value === undefined) continue
    const key = JSON.stringify(labels.sort(([a], [b]) => a.localeCompare(b)))
    const series = values.get(key) ?? new Map<string, number>()
    series.set(name, value)
    values.set(key, series)
  }
  const speeds: number[] = []
  for (const series of values.values()) {
    const speed = dialect === 'llamacpp' ? series.get('llamacpp:prompt_tokens_seconds') : positive((series.get('sglang:prompt_tokens_total') ?? 0) / (series.get('sglang:time_to_first_token_seconds_sum') ?? 0))
    if (speed !== undefined) speeds.push(speed)
  }
  return speeds.length ? Math.min(...speeds) : undefined
}

export async function readCompatPrefillSpeed(
  endpoint: CompatEndpointSettings & { baseUrl: string },
  model: string,
  opts: { key?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<number | undefined> {
  const dialect = endpoint.dialect
  if (dialect !== 'llamacpp' && dialect !== 'sglang' || opts.signal?.aborted) return undefined
  const root = compatServerBase(endpoint.baseUrl).replace(/\/v1$/, '')
  const cacheKey = `${dialect}:${root}:${model}`
  const cached = readings.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.speed
  const controller = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), 1000)
  timer.unref?.()
  const read = async (path: string): Promise<string | undefined> => {
    const response = await (opts.fetchImpl ?? getApiFetch())(`${root}${path}`, {
      ...getProxyFetchOptions(), method: 'GET', redirect: 'error', signal,
      headers: { ...endpoint.headers, accept: 'text/plain, application/json', 'user-agent': getUserAgent(), ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
    } as RequestInit)
    if (!response.ok) { await response.body?.cancel(); return undefined }
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 512 * 1024) return undefined
        chunks.push(chunk.value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally { void reader.cancel().catch(() => {}) }
  }
  let speed: number | undefined
  try {
    let servedModel = model
    if (dialect === 'sglang') {
      const info = await read('/get_model_info')
      if (info === undefined) return undefined
      const body = JSON.parse(info) as { model_path?: unknown; served_model_name?: unknown }
      if (body.served_model_name !== model && body.model_path !== model) return undefined
      servedModel = typeof body.served_model_name === 'string' ? body.served_model_name : model
    }
    const metrics = await read(dialect === 'llamacpp' ? `/metrics?model=${encodeURIComponent(model)}` : '/metrics')
    if (metrics !== undefined) speed = prefillSpeedFromMetrics(dialect, metrics, servedModel)
  } catch {
    speed = undefined
  } finally {
    clearTimeout(timer)
    readings.set(cacheKey, { at: Date.now(), speed })
    if (readings.size > 128) readings.delete(readings.keys().next().value!)
  }
  return speed
}
