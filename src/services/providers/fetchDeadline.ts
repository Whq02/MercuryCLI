/**
 * The provider-call deadline law: no login, account-probe, or catalogue
 * request runs without a deadline, and a breach reads in operator words —
 * `timed out after <n>s — <provider> did not answer` — never the runtime's
 * own abort spelling. The operator's own esc/Ctrl-C stays a different
 * sentence entirely ("closed — no credential changed"): cancelling and
 * timing out are different facts and the screen says which one happened.
 */

/** The deadline in operator words: whole seconds plain, fractions to one
 *  decimal (15000 → "15s", 1500 → "1.5s"). */
export function deadlineSecondsLabel(ms: number): string {
  const seconds = ms / 1000
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`
}

/** A breach of AbortSignal.timeout — undici and Bun spell it TimeoutError
 *  (DOMException) or an AbortError whose cause carries the timeout name. */
export function isDeadlineBreach(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError') return true
  if (error.name === 'AbortError') return true
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
}

/** The honest breach line. */
export function deadlineBreachLine(provider: string, ms: number): string {
  return `timed out after ${deadlineSecondsLabel(ms)} — ${provider} did not answer`
}

/**
 * One provider request under one deadline. A breach throws the honest line;
 * every other failure passes through untouched. A caller-supplied signal
 * COMPOSES with the deadline — it is never discarded (the old overwrite ran
 * the full deadline past a caller's abort and then reported that cancel as
 * a timeout, field F-6.1). Only the deadline leg relabels: the caller's own
 * abort passes through untouched, so cancelling and timing out stay
 * different facts on the screen.
 */
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
    return await fetchImpl(url as never, { ...init, signal } as never)
  } catch (error) {
    // When both legs aborted inside the race window, the caller's gesture
    // wins the sentence: a cancelled request is never called a timeout.
    if (isDeadlineBreach(error) && deadline.aborted && !(callerSignal?.aborted ?? false)) {
      throw new Error(deadlineBreachLine(provider, timeoutMs))
    }
    throw error
  }
}
