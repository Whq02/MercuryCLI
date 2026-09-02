import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Turn-scoped "workload" tag carried through async context.
 *
 * This module lives apart from bootstrap state on purpose: bootstrap is
 * reachable from the browser SDK entrypoint, and the browser bundle cannot
 * pull in Node's async-hooks. And a module-global slot cannot substitute
 * for async-scoped storage: un-awaited background work suspends at its
 * first await while the dispatching turn runs its own cleanup to
 * completion, so a global written inside the background body is
 * overwritten before it can be observed. Async-scoped storage binds the
 * value to the asynchronous chain through each suspension.
 *
 * Value constraint (contract data): the server-side sanitizer accepts only
 * lowercase [a-z0-9_-], length 0-32 — an uppercase character stops parsing
 * at position 0.
 */

export type Workload = 'cron'

export const WORKLOAD_CRON: Workload = 'cron'

const workloadStorage = new AsyncLocalStorage<string | undefined>()

export function getWorkload(): string | undefined {
  return workloadStorage.getStore()
}

/**
 * ALWAYS enters a fresh context, `undefined` included — never degrade to
 * calling the callback directly when there is no workload to set. An
 * ambient value can already be in scope (the end-of-turn notification
 * chain schedules work that captures whatever context is live and later
 * runs queued input inside it); entering unconditionally overwrites that
 * ambient value with exactly what the caller passed. Skipping the entry
 * would let the wrong tag persist for the rest of the session with no
 * event that clears it.
 */
export function runWithWorkload<T>(workload: string | undefined, fn: () => T): T {
  return workloadStorage.run(workload, fn)
}
