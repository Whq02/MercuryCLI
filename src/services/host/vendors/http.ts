import { setTimeout as delay } from 'node:timers/promises'
import type { z } from 'zod/v4'
import type { HostPod } from './vendor.js'

export class HostCreateError extends Error {
  constructor(message: string, readonly outcome: 'refused' | 'ambiguous', readonly instanceId?: string, readonly status?: number, readonly code?: string) { super(message) }
}

export class HostVendorHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface VendorTiming { requestTimeoutMs?: number; readyTimeoutMs?: number; pollMs?: number; settleMs?: number }

export const keyMaterial = (key: string): string => key.trim().split(/\s+/).slice(0, 2).join(' ')
export const isOpenSshKey = (key: string): boolean => /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/]+={0,3}(?: [^\r\n\0]*)?$/.test(key.trim())

class RateGate {
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

const gates = new Map<string, RateGate>()
const queues = new Map<string, Promise<void>>()
const uncertainCreates = new Map<string, Map<string, number>>()

export class VendorApi {
  readonly base: string
  private readonly account: string
  private readonly gate: RateGate | undefined
  private observedPolicy: string | undefined
  constructor(readonly label: string, private key: string, base: string, official: string, private refusals: readonly number[], private timing: VendorTiming, paced = false) {
    let url: URL
    try { url = new URL(base) } catch { throw new Error(label + ' needs a valid API URL.') }
    const allowed = new URL(official)
    if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== allowed.pathname || !(url.origin === allowed.origin || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error(label + ' uses its official API or a loopback fixture only.')
    if (!key.trim()) throw new Error(label + ' needs an API key.')
    this.base = base.replace(/\/$/, '')
    this.account = JSON.stringify([this.base, key])
    let gate = gates.get(this.account)
    if (paced && !gate) { gate = new RateGate(); gates.set(this.account, gate) }
    this.gate = paced ? gate : undefined
  }
  redact(text: string): string {
    return [this.key, encodeURIComponent(this.key), JSON.stringify(this.key).slice(1, -1)].reduce((value, secret) => secret ? value.split(secret).join('[redacted]') : value, text)
  }
  policy(): string | undefined { return this.observedPolicy }
  ambiguous(status?: number): HostCreateError {
    return new HostCreateError(this.label + ' instance may exist; no second create was sent. Check the instance list in the ' + this.label + ' console before renting again.', 'ambiguous', undefined, status)
  }
  created(id: string, reason: string): HostCreateError {
    return new HostCreateError(this.redact(this.label + ' created instance ' + id + ', but ' + reason + '; it is billing. No second create was sent; manage it in the ' + this.label + ' instance list.'), 'ambiguous', id)
  }
  async serial<T>(work: () => Promise<T>): Promise<T> {
    const turn = (queues.get(this.account) ?? Promise.resolve()).then(work)
    queues.set(this.account, turn.then(() => {}, () => {}))
    return turn
  }
  remember(name: string): void {
    const pending = uncertainCreates.get(this.account) ?? new Map<string, number>()
    pending.set(name, Date.now())
    uncertainCreates.set(this.account, pending)
  }
  async reconcile(list: () => Promise<readonly HostPod[]>): Promise<void> {
    const pending = uncertainCreates.get(this.account)
    if (!pending?.size) return
    const rows = await list()
    for (const [name, at] of [...pending]) {
      const found = rows.find(row => row.name === name)
      if (found) {
        pending.delete(name)
        throw new HostCreateError(this.redact(this.label + ' created ' + name + ' (ID ' + found.id + ') from the earlier unanswered request; it is billing. No new rental was sent; manage that instance in the ' + this.label + ' instance list.'), 'refused')
      }
      if (Date.now() - at < (this.timing.settleMs ?? 120000)) throw new HostCreateError(this.redact('The earlier ' + this.label + ' request for ' + name + ' got no clear answer and the instance list does not show it yet; no new rental was sent. Check the instance list again in a minute.'), 'refused')
      pending.delete(name)
    }
  }
  async readBack(id: string, read: () => Promise<HostPod>): Promise<HostPod> {
    for (let attempt = 1; ; attempt++) {
      try { return await read() } catch {
        if (attempt >= 3) throw this.created(id, 'reading it back failed')
        await delay(this.timing.pollMs ?? 2500)
      }
    }
  }
  async request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, signal?: AbortSignal, paid = false): Promise<T> {
    let sending = false
    try {
      await this.gate?.take(paid, signal)
      const fresh = method !== 'GET' && path !== '/bundles/'
      const timeout = AbortSignal.timeout(this.timing.requestTimeoutMs ?? 30000)
      sending = true
      const response = await fetch(this.base + path, {
        method, headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json', ...(fresh ? { Connection: 'close' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(fresh ? { keepalive: false } : {}), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      this.observedPolicy = response.headers.get('ratelimit-policy') ?? this.observedPolicy
      if (response.status === 429) this.gate?.throttle(response.headers.get('retry-after'))
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let detail = ''
        let code = ''
        try {
          const problem = JSON.parse(text) as { msg?: unknown; message?: unknown; detail?: unknown; error?: { message?: unknown; code?: unknown } | string }
          detail = String(problem.msg ?? problem.message ?? problem.detail ?? (typeof problem.error === 'string' ? problem.error : problem.error?.message) ?? '')
          code = String((typeof problem.error === 'string' ? problem.error : problem.error?.code) ?? '')
        } catch {
          if (!/^\s*</.test(text)) detail = text
        }
        detail = this.redact(detail).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 240)
        code = this.redact(code).replace(/[^\w./-]+/g, '').slice(0, 80)
        if (paid && !this.refusals.includes(response.status)) throw this.ambiguous(response.status)
        const message = this.redact(this.label + ' ' + method + ' ' + path.split('?')[0] + ' returned HTTP ' + response.status + (detail ? ' · ' + detail : '') + (paid ? ' · ' + this.label + ' refused it; nothing was rented.' : ''))
        if (paid) throw new HostCreateError(message, 'refused', undefined, response.status, code || undefined)
        throw new HostVendorHttpError(message, response.status)
      }
      const parsed = schema.safeParse(await response.json())
      if (!parsed.success) throw new Error('unreadable response')
      return parsed.data
    } catch (error) {
      if (error instanceof HostCreateError || error instanceof HostVendorHttpError) throw error
      if (paid && sending) throw this.ambiguous()
      if (paid) throw new HostCreateError(this.label + ' request was not sent; nothing was rented.', 'refused')
      throw new Error(this.redact(this.label + ' ' + method + ' ' + path.split('?')[0] + ' failed or returned an unreadable response. Check the ' + this.label + ' console.'))
    }
  }
}
