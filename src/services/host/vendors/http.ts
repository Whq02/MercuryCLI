import { setTimeout as delay } from 'node:timers/promises'
import type { z } from 'zod/v4'

export class HostCreateError extends Error {
  constructor(message: string, readonly outcome: 'refused' | 'ambiguous', readonly instanceId?: string, readonly status?: number) { super(message) }
}

export class HostVendorHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface VendorTiming { requestTimeoutMs?: number; readyTimeoutMs?: number; pollMs?: number }

export class LambdaRateGate {
  private nextRequest = 0
  private nextLaunch = 0
  private blockedUntil = 0
  private tail: Promise<void> = Promise.resolve()
  async take(launch: boolean, signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(async () => {
      for (;;) {
        signal?.throwIfAborted()
        const wait = Math.max(this.nextRequest, this.blockedUntil, launch ? this.nextLaunch : 0) - Date.now()
        if (wait <= 0) break
        await delay(Math.min(wait, 2147483647), undefined, { signal })
      }
      this.nextRequest = Date.now() + 1000
      if (launch) this.nextLaunch = Date.now() + 12000
    })
    this.tail = turn.catch(() => {})
    await turn
  }
  throttle(retryAfter: string | null): void {
    const seconds = Number(retryAfter)
    const deadline = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : Date.now() + (seconds > 0 ? seconds * 1000 : 1000)
    this.blockedUntil = Math.max(this.blockedUntil, Number.isFinite(deadline) ? deadline : Date.now() + 1000)
  }
}

const lambdaGates = new Map<string, Map<string, LambdaRateGate>>()
export function lambdaRateGate(base: string, key: string): LambdaRateGate {
  let keys = lambdaGates.get(base)
  if (!keys) { keys = new Map(); lambdaGates.set(base, keys) }
  let gate = keys.get(key)
  if (!gate) { gate = new LambdaRateGate(); keys.set(key, gate) }
  return gate
}

export class VendorApi {
  readonly base: string
  private observedPolicy: string | undefined
  constructor(readonly label: string, private key: string, base: string, official: string, private refusals: readonly number[], private timing: VendorTiming, private gate?: LambdaRateGate) {
    let url: URL
    try { url = new URL(base) } catch { throw new Error(label + ' needs a valid API URL.') }
    const allowed = new URL(official)
    if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== allowed.pathname || !(url.origin === allowed.origin || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error(label + ' uses its official API or a loopback fixture only.')
    if (!key.trim()) throw new Error(label + ' needs an API key.')
    this.base = base.replace(/\/$/, '')
  }
  redact(text: string): string {
    return [this.key, encodeURIComponent(this.key), JSON.stringify(this.key).slice(1, -1)].reduce((value, secret) => secret ? value.split(secret).join('[redacted]') : value, text)
  }
  policy(): string | undefined { return this.observedPolicy }
  ambiguous(id?: string, status?: number): HostCreateError {
    return new HostCreateError(this.redact(this.label + ' instance may exist' + (id ? ' (ID ' + id + ')' : '') + '; no second create was sent. Check the instance list in the ' + this.label + ' console before renting again.'), 'ambiguous', id, status)
  }
  async request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, signal?: AbortSignal, paid = false): Promise<T> {
    try {
      await this.gate?.take(paid, signal)
      const fresh = method !== 'GET' && path !== '/bundles/'
      const response = await fetch(this.base + path, {
        method, headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json', ...(fresh ? { Connection: 'close' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(fresh ? { keepalive: false } : {}), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timing.requestTimeoutMs ?? 30000)]) : AbortSignal.timeout(this.timing.requestTimeoutMs ?? 30000),
      })
      this.observedPolicy = response.headers.get('ratelimit-policy') ?? this.observedPolicy
      if (response.status === 429) this.gate?.throttle(response.headers.get('retry-after'))
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let detail = ''
        try {
          const problem = JSON.parse(text) as { msg?: unknown; detail?: unknown; error?: { message?: unknown } | string }
          detail = String(problem.msg ?? problem.detail ?? (typeof problem.error === 'string' ? problem.error : problem.error?.message) ?? '')
        } catch {}
        detail = this.redact(detail).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 240)
        if (paid && !this.refusals.includes(response.status)) throw this.ambiguous(undefined, response.status)
        const message = this.redact(this.label + ' ' + method + ' ' + path.split('?')[0] + ' returned HTTP ' + response.status + (detail ? ' · ' + detail : '') + (paid ? ' · ' + this.label + ' refused it; nothing was rented.' : ''))
        if (paid) throw new HostCreateError(message, 'refused', undefined, response.status)
        throw new HostVendorHttpError(message, response.status)
      }
      const parsed = schema.safeParse(await response.json())
      if (!parsed.success) throw new Error('unreadable response')
      return parsed.data
    } catch (error) {
      if (error instanceof HostCreateError || error instanceof HostVendorHttpError) throw error
      if (paid) throw this.ambiguous()
      throw new Error(this.redact(this.label + ' ' + method + ' ' + path.split('?')[0] + ' failed or returned an unreadable response. Check the ' + this.label + ' console.'))
    }
  }
}
