import { AsyncLocalStorage } from 'node:async_hooks'

import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

/**
 * The current-working-directory accessor with an async-context override.
 *
 * The override is contextual, not global: two concurrent agents each observe
 * their own directory and neither sees the other's; nested overrides shadow
 * outer ones for the duration of the inner callback. With no override active
 * the value comes from the bootstrap state module's mutable working-directory
 * slot (which cd-like commands update).
 */
const cwdOverrideStorage = new AsyncLocalStorage<string>()

/**
 * Run `fn` — and every async descendant of it — observing `cwd` as the
 * working directory. Generic in the return type and does not await: an async
 * callback's promise is returned as-is.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/** The logical working directory. May throw if bootstrap state is unavailable. */
export function pwd(): string {
  const override = cwdOverrideStorage.getStore()
  if (override !== undefined) return override
  return getCwdState()
}

/** As pwd, falling back to the originally-recorded startup directory. */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
