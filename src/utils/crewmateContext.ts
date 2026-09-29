import { AsyncLocalStorage } from 'node:async_hooks'


export type CrewmateContext = {
  agentId: string
  agentName: string
  crewName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string
  kind: 'in-process'
  abortController: AbortController
}

const crewmateContextStorage = new AsyncLocalStorage<CrewmateContext>()

export function createCrewmateContext(config: Omit<CrewmateContext, 'kind'>): CrewmateContext {
  return { ...config, kind: 'in-process' }
}

export function runWithCrewmateContext<T>(context: CrewmateContext, fn: () => T): T {
  return crewmateContextStorage.run(context, fn)
}

export function getCrewmateContext(): CrewmateContext | undefined {
  return crewmateContextStorage.getStore()
}

export function isInProcessCrewmate(): boolean {
  return crewmateContextStorage.getStore() !== undefined
}
