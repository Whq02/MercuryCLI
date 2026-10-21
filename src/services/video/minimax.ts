import { metadataRefusal, metadataSafeAddresses } from '../../tools/WebFetchTool/privateHost.js'
import { resolveMinimaxApiKey } from '../providers/minimax/minimaxAccounts.js'
import type { VideoJob, VideoProvider, VideoStatus } from './types.js'

export const MINIMAX_VIDEO_BASE = 'https://api.minimax.io'
export const MINIMAX_VIDEO_MODEL = 'MiniMax-H3'
export const VIDEO_POLL_INTERVAL_MS = 10_000

function loopback(url: URL): boolean {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
}

export function videoBaseUrl(value = MINIMAX_VIDEO_BASE): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Video baseUrl must be an origin, without credentials, path, query or fragment.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) {
    throw new Error('Video baseUrl requires HTTPS (HTTP is allowed only for a loopback provider).')
  }
  const refusal = metadataRefusal(url.href)
  if (refusal) throw new Error(refusal)
  return url.origin
}

export class VideoProviderRefusal extends Error {}

function vendorError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const error = (value as { error?: { message?: unknown } }).error
  return typeof error?.message === 'string' ? error.message : undefined
}

export class MiniMaxVideoProvider implements VideoProvider {
  readonly pollIntervalMs = VIDEO_POLL_INTERVAL_MS
  readonly baseUrl: string
  private readonly tasks = new Map<string, VideoStatus>()

  constructor(baseUrl?: string) {
    this.baseUrl = videoBaseUrl(baseUrl)
  }

  private async request(path: string, signal: AbortSignal, job?: VideoJob): Promise<unknown> {
    signal.throwIfAborted()
    const credential = resolveMinimaxApiKey()
    if (!credential) throw new VideoProviderRefusal('Video needs a MiniMax key — /logins minimax stores an Open Platform pay-as-you-go API key; videoProvider.<name> = { kind: "minimax" } selects the generator in settings.')
    await metadataSafeAddresses(this.baseUrl)
    signal.throwIfAborted()
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: job ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${credential.key}`, ...(job ? { 'Content-Type': 'application/json' } : {}) },
      ...(job ? { body: JSON.stringify(job) } : {}),
      redirect: 'error',
      signal,
    })
    const text = await response.text()
    let value: unknown
    try { value = JSON.parse(text) } catch {
      const Failure = response.ok ? Error : VideoProviderRefusal
      throw new Failure(text || `MiniMax video returned HTTP ${response.status} without a response body.`)
    }
    const error = vendorError(value)
    if (error !== undefined) throw new VideoProviderRefusal(error)
    if (!response.ok) throw new VideoProviderRefusal(text || `MiniMax video returned HTTP ${response.status}.`)
    return value
  }

  async create(job: VideoJob, signal: AbortSignal): Promise<string> {
    const value = await this.request('/v2/video_generation', signal, job) as { task_id?: unknown }
    if (typeof value?.task_id !== 'string' || !value.task_id) throw new Error('MiniMax video create returned no task_id; do not resubmit automatically because a billable job may exist.')
    return value.task_id
  }

  async status(id: string, signal: AbortSignal): Promise<VideoStatus> {
    const value = await this.request(`/v2/query/video_generation/${encodeURIComponent(id)}`, signal) as {
      task?: { id?: string; status?: string; duration?: number; content?: { url?: string }; usage?: Record<string, unknown>; error?: { message?: string } }
    }
    const task = value?.task
    if (!task || task.id !== id || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(task.status ?? '')) {
      throw new Error('MiniMax video query returned no matching task with a documented status.')
    }
    const usage = task.usage && Object.fromEntries(Object.entries(task.usage).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
    const status: VideoStatus = {
      id,
      state: task.status as VideoStatus['state'],
      ...(typeof task.duration === 'number' ? { duration: task.duration } : {}),
      ...(typeof task.content?.url === 'string' ? { url: task.content.url } : {}),
      ...(usage ? { usage } : {}),
      ...(typeof task.error?.message === 'string' ? { error: task.error.message } : {}),
    }
    this.tasks.set(id, status)
    return status
  }

  private async download(url: string, signal: AbortSignal): Promise<Response> {
    const target = new URL(url)
    const localFixture = loopback(new URL(this.baseUrl)) && target.origin === this.baseUrl
    if (target.username || target.password || (target.protocol !== 'https:' && !localFixture)) {
      throw new Error('MiniMax video returned an unsafe download URL; no download was attempted.')
    }
    await metadataSafeAddresses(target.href)
    signal.throwIfAborted()
    return fetch(target, { signal, redirect: 'error' })
  }

  async fetch(id: string, signal: AbortSignal): Promise<Uint8Array> {
    let task = this.tasks.get(id) ?? await this.status(id, signal)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (task.state !== 'succeeded' || !task.url) throw new Error(task.error ?? `MiniMax video task ${id} has no downloadable result (${task.state}).`)
      const response = await this.download(task.url, signal)
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') {
          throw new Error('MiniMax video download was not an MP4; no video was saved.')
        }
        return bytes
      }
      const message = await response.text()
      if (attempt === 0 && [401, 403, 404, 410].includes(response.status)) {
        task = await this.status(id, signal)
        continue
      }
      throw new Error(message || `MiniMax video download returned HTTP ${response.status}.`)
    }
    throw new Error('MiniMax video download URL is still expired after refreshing the task.')
  }
}
