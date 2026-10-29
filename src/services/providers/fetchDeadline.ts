
export function deadlineSecondsLabel(ms: number): string {
  const seconds = ms / 1000
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`
}

export function isDeadlineBreach(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError') return true
  if (error.name === 'AbortError') return true
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
}

export function deadlineBreachLine(provider: string, ms: number): string {
  return `timed out after ${deadlineSecondsLabel(ms)} — ${provider} did not answer`
}

import { captureSignInRequest, observeSignInResponse } from '../../utils/accounts/signInRefusal.js'

export async function fetchWithProviderDeadline(
  fetchImpl: typeof fetch,
  provider: string,
  timeoutMs: number,
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const callerSignal = init?.signal ?? null
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
  try {
    const headers = new Headers(init?.headers)
    const credential = headers.get('authorization')?.replace(/^Bearer /i, '') ?? headers.get('x-api-key') ?? headers.get('x-goog-api-key') ?? new URL(url).searchParams.get('key')
    const catalogue = /(?:^|\/)models(?:\/|$)|:fetchAvailableModels$/.test(new URL(url).pathname)
    const observation = credential && catalogue ? captureSignInRequest(provider, credential) : undefined
    const response = await fetchImpl(url as never, { ...init, signal } as never)
    observeSignInResponse(observation, response.status)
    return response
  } catch (error) {
    if (isDeadlineBreach(error) && deadline.aborted && !(callerSignal?.aborted ?? false)) {
      throw new Error(deadlineBreachLine(provider, timeoutMs))
    }
    throw error
  }
}
