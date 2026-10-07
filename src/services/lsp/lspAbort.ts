import { AsyncLocalStorage } from 'node:async_hooks'

type LspCallScope = { signal: AbortSignal | undefined; faults: number }
const lspAbortStorage = new AsyncLocalStorage<LspCallScope>()

export function runWithLspAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  if (signal === undefined) return fn()
  return lspAbortStorage.run({ signal, faults: 0 }, fn)
}

export function currentLspAbortSignal(): AbortSignal | undefined {
  return lspAbortStorage.getStore()?.signal
}

export function noteLspRequestFault(): void {
  const scope = lspAbortStorage.getStore()
  if (scope && !scope.signal?.aborted) scope.faults++
}

export function lspRequestFaultCount(): number {
  return lspAbortStorage.getStore()?.faults ?? 0
}
