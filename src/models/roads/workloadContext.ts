import { getOwnerContext, withOwnerContext } from '../../engine/run-owner/ownerContext.js'


export type Workload = 'cron' | 'advisor'

export const WORKLOAD_CRON: Workload = 'cron'

export const WORKLOAD_ADVISOR: Workload = 'advisor'

export function getWorkload(): string | undefined {
  return getOwnerContext()?.workload
}

export function runWithWorkload<T>(workload: string | undefined, fn: () => T): T {
  return withOwnerContext({ workload }, fn)
}
