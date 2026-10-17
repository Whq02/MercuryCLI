import { AsyncLocalStorage } from 'node:async_hooks'

import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

type CwdContext = { cwd: string | undefined; shellCwd: string | null }

const cwdOverrideStorage = new AsyncLocalStorage<CwdContext>()

export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run({ cwd, shellCwd: null }, fn)
}

export function runWithOwnShellCwd<T>(fn: () => T): T {
  return cwdOverrideStorage.run({ cwd: getCwd(), shellCwd: null }, fn)
}

export function contextShellCwd(): string | null | undefined {
  const store = cwdOverrideStorage.getStore()
  return store === undefined ? undefined : store.shellCwd
}

export function setContextShellCwd(next: string | null): boolean {
  const store = cwdOverrideStorage.getStore()
  if (store === undefined) return false
  store.shellCwd = next
  return true
}

export function getStartingCwd(): string {
  return cwdOverrideStorage.getStore()?.cwd ?? getOriginalCwd()
}

export function pwd(): string {
  const override = cwdOverrideStorage.getStore()?.cwd
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
