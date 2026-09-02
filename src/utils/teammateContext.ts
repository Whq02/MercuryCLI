import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Async-scoped identity for teammates that run inside this process. The
 * abort controller is supplied by the caller and is typically independent
 * of the parent's, so interrupting the leader's own turn does not cancel a
 * teammate mid-work.
 */

export type TeammateContext = {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string
  /** Discriminator marking this context as in-process. */
  kind: 'in-process'
  abortController: AbortController
}

const teammateContextStorage = new AsyncLocalStorage<TeammateContext>()

export function createTeammateContext(config: Omit<TeammateContext, 'kind'>): TeammateContext {
  return { ...config, kind: 'in-process' }
}

export function runWithTeammateContext<T>(context: TeammateContext, fn: () => T): T {
  return teammateContextStorage.run(context, fn)
}

export function getTeammateContext(): TeammateContext | undefined {
  return teammateContextStorage.getStore()
}

export function isInProcessTeammate(): boolean {
  return teammateContextStorage.getStore() !== undefined
}
