import { AsyncLocalStorage } from 'node:async_hooks'

import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

export function pwd(): string {
  const override = cwdOverrideStorage.getStore()
  if (override !== undefined) return override
  return getCwdState()
}

export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
