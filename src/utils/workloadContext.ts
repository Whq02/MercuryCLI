import { AsyncLocalStorage } from 'node:async_hooks'


export type Workload = 'cron'

export const WORKLOAD_CRON: Workload = 'cron'

const workloadStorage = new AsyncLocalStorage<string | undefined>()

export function getWorkload(): string | undefined {
  return workloadStorage.getStore()
}

export function runWithWorkload<T>(workload: string | undefined, fn: () => T): T {
  return workloadStorage.run(workload, fn)
}
