import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The ONE cancellation observer for language-server requests.
 *
 * A tool call arms this door once around its whole operation; every request
 * the operation makes — however deep, however many servers it fans across —
 * reads the same signal from the async context. Threading a signal through
 * every call site is the shape that let a request forget one: the audit's
 * finding was that NO request observed the operator's abort at all, so the
 * turn machine's abort check (which runs only after tool results settle)
 * could never be reached.
 *
 * Contextual, not global: two concurrent agents each observe their own
 * signal, and nested arms shadow outer ones for the inner callback.
 */
const lspAbortStorage = new AsyncLocalStorage<AbortSignal>()

/**
 * Run `fn` — and every async descendant of it — with `signal` as the
 * cancellation observer every language-server request consults. An
 * undefined signal runs `fn` unchanged (an unarmed caller keeps the
 * deadline as its only bound).
 */
export function runWithLspAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (signal === undefined) return fn()
  return lspAbortStorage.run(signal, fn)
}

/** The armed signal for this async context, or undefined. */
export function currentLspAbortSignal(): AbortSignal | undefined {
  return lspAbortStorage.getStore()
}
