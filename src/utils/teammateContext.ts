import { AsyncLocalStorage } from 'node:async_hooks'


export type TeammateContext = {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string
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
