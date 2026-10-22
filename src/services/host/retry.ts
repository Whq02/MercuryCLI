import { setTimeout as delay } from 'node:timers/promises'
import { RunpodHttpError } from './runpod.js'
import { HostVendorHttpError, HostVendorNetworkError } from './vendors/http.js'

interface HostReadRetryOptions {
  label: string
  pauseMs: number
  timeoutMs: number
  deadline?: number
  signal: AbortSignal
  mark: (step: string) => void
}
export type HostReadOnly = <T>(operation: string, read: (signal: AbortSignal) => Promise<T>) => Promise<T>
interface ReadFailure { label: string; operation: string; elapsed: number; counts: Map<string, number> }
const failures = new WeakMap<object, ReadFailure>()
const httpError = (error: unknown): RunpodHttpError | HostVendorHttpError | undefined => error instanceof RunpodHttpError || error instanceof HostVendorHttpError ? error : undefined
const networkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if (error instanceof HostVendorNetworkError || error.name === 'TimeoutError') return true
  const code = (error as NodeJS.ErrnoException).code
  return Boolean(code && /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) || error instanceof TypeError && /fetch failed|network|connection/i.test(error.message) || error.cause !== undefined && networkError(error.cause)
}
const duration = (ms: number): string => ms >= 60_000 ? Math.round(ms / 60_000) + ' min' : Math.max(1, Math.round(ms / 1000)) + ' s'
const counted = (failure: ReadFailure): string => [...failure.counts].map(([kind, count]) => kind + ' ×' + count).join(', ')
export function hostReadFailureWords(error: unknown): string | undefined {
  const failure = typeof error === 'object' && error ? failures.get(error) : undefined
  return failure && failure.label + ' did not answer ' + failure.operation + ' reads for ' + duration(failure.elapsed) + ' (' + counted(failure) + ')'
}
export class HostTerminationUnconfirmed extends Error {
  constructor(label: string, error: unknown) {
    const failure = typeof error === 'object' && error ? failures.get(error) : undefined
    super('termination sent; ' + label + ' did not confirm (' + (failure ? counted(failure) : httpError(error) ? 'HTTP ' + httpError(error)!.status : 'listing unavailable') + ') — check Pods I’m paying for', { cause: error })
  }
}
export function hostJobReadOnly(options: HostReadRetryOptions): HostReadOnly {
  return async (operation, read) => {
    const started = Date.now()
    const deadline = Math.min(options.deadline ?? Infinity, started + Math.min(4 * 60_000, options.timeoutMs))
    const controller = new AbortController()
    const signal = AbortSignal.any([options.signal, controller.signal])
    const remaining = Math.max(1, deadline - started)
    const timer = setTimeout(() => controller.abort(new DOMException('Vendor read budget exhausted', 'TimeoutError')), remaining)
    const counts = new Map<string, number>()
    let wait = Math.max(1, options.pauseMs)
    let attempt = 0
    let last: unknown
    const exhausted = (): never => {
      const error = last ?? signal.reason ?? new Error('Vendor read budget exhausted')
      if (typeof error === 'object' && error) failures.set(error, { label: options.label, operation, elapsed: Date.now() - started, counts })
      throw error
    }
    try {
      for (;;) {
        options.signal.throwIfAborted()
        if (controller.signal.aborted || Date.now() >= deadline) exhausted()
        try {
          const value = await read(signal)
          options.signal.throwIfAborted()
          if (controller.signal.aborted) exhausted()
          if (attempt) options.mark(options.label + ' ' + operation + ' read recovered · continuing')
          return value
        } catch (error) {
          options.signal.throwIfAborted()
          if (controller.signal.aborted) { last ??= error; if (!counts.size) counts.set('network error', 1); exhausted() }
          const http = httpError(error)
          if (http ? http.status !== 429 && (http.status < 500 || http.status > 599) : !networkError(error)) throw error
          last = error
          attempt++
          const kind = http ? 'HTTP ' + http.status : 'network error'
          counts.set(kind, (counts.get(kind) ?? 0) + 1)
          wait = Math.max(Math.min(60_000, wait * 2), (http?.retryAfterSeconds ?? 0) * 1000)
          const left = deadline - Date.now()
          if (left <= 0) exhausted()
          options.mark(options.label + ' read failed (' + kind + ') · retrying in ' + Math.ceil(wait / 1000) + ' s · attempt ' + attempt)
          try { await delay(Math.min(wait, left), undefined, { signal }) } catch {
            options.signal.throwIfAborted()
            exhausted()
          }
        }
      }
    } finally { clearTimeout(timer) }
  }
}
