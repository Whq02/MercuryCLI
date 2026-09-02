import { AsyncLocalStorage } from 'node:async_hooks'

const lspAbortStorage = new AsyncLocalStorage<AbortSignal>()

export function runWithLspAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (signal === undefined) return fn()
  return lspAbortStorage.run(signal, fn)
}

export function currentLspAbortSignal(): AbortSignal | undefined {
  return lspAbortStorage.getStore()
}
