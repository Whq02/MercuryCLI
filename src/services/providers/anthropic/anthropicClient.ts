import type { ApiMessage } from '../../../types/wire.js'
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '../../api/sdkErrors.js'
import { AnthropicStream } from './anthropicStream.js'
import type { AnthropicMessageParams } from './anthropicWire.js'

export type AnthropicClientOptions = {
  apiKey?: string | null
  authToken?: string | null
  baseURL?: string
  timeout?: number
  maxRetries?: number
  defaultHeaders?: Record<string, string | null | undefined>
  fetch?: typeof globalThis.fetch
  fetchOptions?: RequestInit & Record<string, unknown>
  dangerouslyAllowBrowser?: boolean
}

type RequestOptions = {
  signal?: AbortSignal
  timeout?: number
  maxRetries?: number
  headers?: Record<string, string | null | undefined>
  fetchOptions?: RequestInit & Record<string, unknown>
}
type Answer<T> = { data: T; response: Response; request_id: string | null }
type RequestHandle<T> = Promise<T> & { withResponse(): Promise<Answer<T>> }
type CountParams = Omit<AnthropicMessageParams, 'max_tokens'>

function mergeHeaders(target: Headers, incoming: Record<string, string | null | undefined> | undefined, omitted: Set<string>): void {
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === null) { target.delete(key); omitted.add(key.toLowerCase()) }
    else if (value !== undefined) { target.set(key, value); omitted.delete(key.toLowerCase()) }
  }
}

function retryDelay(headers: Headers | undefined, attempt: number): number {
  const milliseconds = headers?.get('retry-after-ms')
  const seconds = headers?.get('retry-after')
  const ms = milliseconds ? Number.parseFloat(milliseconds) : NaN
  if (Number.isFinite(ms) && ms !== 0) return Math.max(0, ms)
  if (seconds) {
    const n = Number.parseFloat(seconds)
    const value = Number.isNaN(n) ? Date.parse(seconds) - Date.now() : n * 1000
    if (Number.isFinite(value)) return Math.max(0, value)
  }
  if (ms === 0) return 0
  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25)
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new APIUserAbortError()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new APIUserAbortError()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

class Messages {
  constructor(private readonly client: AnthropicClient, private readonly beta: boolean) {}

  create(params: AnthropicMessageParams & { stream: true }, options?: RequestOptions): RequestHandle<AnthropicStream>
  create(params: AnthropicMessageParams & { stream?: false }, options?: RequestOptions): RequestHandle<ApiMessage>
  create(params: AnthropicMessageParams, options?: RequestOptions): RequestHandle<ApiMessage | AnthropicStream>
  create(params: AnthropicMessageParams, options: RequestOptions = {}): RequestHandle<ApiMessage | AnthropicStream> {
    return this.send('/v1/messages', params, options)
  }

  countTokens(params: CountParams, options: RequestOptions = {}): RequestHandle<{ input_tokens: number }> {
    return this.send('/v1/messages/count_tokens', params, options, true)
  }

  private send<T>(path: string, params: AnthropicMessageParams | CountParams, options: RequestOptions, count = false): RequestHandle<T> {
    const { betas, user_profile_id, ...body } = params
    if (body.output_format) {
      if ((body.output_config as { format?: unknown } | undefined)?.format) throw new Error('Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).')
      const format = body.output_format
      delete body.output_format
      body.output_config = { ...body.output_config as object, format }
    }
    const headers: Record<string, string | null | undefined> = {}
    if (this.beta) {
      const values = count ? [...(betas as string[] | undefined ?? []), 'token-counting-2024-11-01'] : betas as string[] | undefined
      if (values) headers['anthropic-beta'] = values.toString()
      if (user_profile_id != null) headers['anthropic-user-profile-id'] = String(user_profile_id)
    }
    const promise = this.client.send<T>(path + (this.beta ? '?beta=true' : ''), body, { ...options, headers: { ...headers, ...options.headers } })
    const value = promise.then(answer => answer.data)
    return Object.assign(value, { withResponse: () => value.then(() => promise) })
  }
}

export class AnthropicClient {
  readonly apiKey: string | null
  readonly authToken: string | null
  readonly baseURL: string
  readonly timeout: number
  readonly maxRetries: number
  readonly messages: Messages
  readonly beta: { messages: Messages }

  constructor(private readonly options: AnthropicClientOptions = {}) {
    this.apiKey = options.apiKey === undefined ? process.env.ANTHROPIC_API_KEY ?? null : options.apiKey
    this.authToken = options.authToken === undefined ? process.env.ANTHROPIC_AUTH_TOKEN ?? null : options.authToken
    this.baseURL = options.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
    this.timeout = options.timeout ?? 600_000
    this.maxRetries = options.maxRetries ?? 2
    this.messages = new Messages(this, false)
    this.beta = { messages: new Messages(this, true) }
  }

  async send<T>(path: string, body: Record<string, unknown>, options: RequestOptions): Promise<Answer<T>> {
    const timeout = options.timeout ?? this.timeout
    const maxRetries = options.maxRetries ?? this.maxRetries
    const url = new URL(this.baseURL.replace(/\/$/, '') + path).toString()
    const headers = new Headers({ accept: 'application/json', 'anthropic-version': '2023-06-01' })
    if (this.options.dangerouslyAllowBrowser) headers.set('anthropic-dangerous-direct-browser-access', 'true')
    if (this.apiKey !== null) headers.set('x-api-key', this.apiKey)
    if (this.authToken !== null) headers.set('authorization', `Bearer ${this.authToken}`)
    const omitted = new Set<string>()
    mergeHeaders(headers, this.options.defaultHeaders, omitted)
    headers.set('content-type', 'application/json')
    mergeHeaders(headers, options.headers, omitted)
    if (!headers.get('x-api-key') && !headers.get('authorization') && !omitted.has('x-api-key') && !omitted.has('authorization')) {
      throw new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted')
    }
    const serialized = JSON.stringify(body)
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new APIUserAbortError()
      const controller = new AbortController()
      let response: Response | undefined
      const abort = () => {
        controller.abort()
        void response?.body?.cancel().catch(() => {})
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      const release = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', release)
      }
      controller.signal.addEventListener('abort', release, { once: true })
      const timer = setTimeout(abort, timeout)
      const bounded = <V>(pending: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
        const onAbort = () => {
          controller.signal.removeEventListener('abort', onAbort)
          reject(options.signal?.aborted ? new APIUserAbortError() : new APIConnectionTimeoutError({ requestDeadline: true }))
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        pending.then(
          value => { controller.signal.removeEventListener('abort', onAbort); resolve(value) },
          error => { controller.signal.removeEventListener('abort', onAbort); reject(error) },
        )
        if (controller.signal.aborted) onAbort()
      })
      try {
        response = await bounded((this.options.fetch ?? globalThis.fetch)(url, {
          method: 'POST', body: serialized, headers,
          ...this.options.fetchOptions, ...options.fetchOptions, signal: controller.signal,
        }))
      } catch (cause) {
        release()
        if (options.signal?.aborted) throw new APIUserAbortError()
        if (attempt < maxRetries) { await waitForRetry(retryDelay(undefined, attempt), options.signal); continue }
        const inner = cause instanceof Error ? cause.cause : undefined
        const timedOut = controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError') || /timed? ?out/i.test(`${String(cause)} ${String(inner ?? '')}`)
        if (timedOut) throw new APIConnectionTimeoutError({ requestDeadline: controller.signal.aborted })
        throw new APIConnectionError({ cause })
      }
      if (!response.ok) {
        const hint = response.headers.get('x-should-retry')
        const retry = hint === 'true' || (hint !== 'false' && ([408, 409, 429].includes(response.status) || response.status >= 500))
        if (retry && attempt < maxRetries) {
          abort()
          await waitForRetry(retryDelay(response.headers, attempt), options.signal)
          continue
        }
        try {
          const text = await bounded(response.text())
          let parsed: unknown
          try { parsed = JSON.parse(text) } catch { parsed = undefined }
          throw APIError.generate(response.status, parsed, parsed ? undefined : text, response.headers)
        } finally { release() }
      }
      const request_id = response.headers.get('request-id')
      if (body.stream) {
        clearTimeout(timer)
        return { data: AnthropicStream.fromSSEResponse(response, controller, release) as T, response, request_id }
      }
      try {
        const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim()
        const json = mediaType?.includes('application/json') || mediaType?.endsWith('+json')
        const data = (response.status === 204 ? null : json
          ? response.headers.get('content-length') === '0' ? undefined : await bounded(response.json())
          : await bounded(response.text())) as T
        if (data && typeof data === 'object' && !Array.isArray(data)) Object.defineProperties(data, {
          _request_id: { value: request_id, enumerable: false },
          _workspace_id: { value: response.headers.get('anthropic-workspace-id'), enumerable: false },
        })
        return { data, response, request_id }
      } finally { release() }
    }
  }
}
