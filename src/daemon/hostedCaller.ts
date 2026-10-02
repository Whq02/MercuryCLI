import { getAncestorPidsAsync } from '../utils/genericProcessUtils.js'
import { parseWorkerParentPid } from './workerParentWatch.js'

export const HOSTED_CALLER_REFUSAL = 'run it from a plain shell; from inside a hosted session your own turn would end'

export type HostedCallerRoad = 'stamp' | 'ancestry'

export type HostedCallerVerdict = { hosted: false } | { hosted: true; daemonPid: number; road: HostedCallerRoad }

export type HostedCallerFacts = { ancestors: readonly number[]; workerParentPid: number | null }

export type HelperPids = number | null | undefined | ReadonlyArray<number | null | undefined>

const usablePid = (pid: number | null | undefined): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 1

function usablePids(pids: HelperPids): number[] {
  const list: ReadonlyArray<number | null | undefined> = Array.isArray(pids) ? pids : [pids as number | null | undefined]
  return list.filter(usablePid)
}

export function hostedCallerVerdict(daemonPids: HelperPids, facts: HostedCallerFacts): HostedCallerVerdict {
  const pids = usablePids(daemonPids)
  const stamped = pids.find(pid => facts.workerParentPid === pid)
  if (stamped !== undefined) return { hosted: true, daemonPid: stamped, road: 'stamp' }
  const ancestor = pids.find(pid => facts.ancestors.includes(pid))
  if (ancestor !== undefined) return { hosted: true, daemonPid: ancestor, road: 'ancestry' }
  return { hosted: false }
}

export async function hostedCallerOf(
  daemonPids: HelperPids,
  opts: { pid?: number; env?: NodeJS.ProcessEnv; ancestors?: (pid: number) => Promise<number[]> } = {},
): Promise<HostedCallerVerdict> {
  const pids = usablePids(daemonPids)
  if (pids.length === 0) return { hosted: false }
  const workerParentPid = parseWorkerParentPid(opts.env ?? process.env)
  const stamped = pids.find(pid => workerParentPid === pid)
  if (stamped !== undefined) return { hosted: true, daemonPid: stamped, road: 'stamp' }
  const ancestors = await (opts.ancestors ?? getAncestorPidsAsync)(opts.pid ?? process.pid)
  return hostedCallerVerdict(pids, { ancestors, workerParentPid })
}

export function restartEndsHostedCaller(first: { heal: string; live: number; daemon: { predecessorPids?: number[] } | null }): boolean {
  return first.heal === 'operator' || (first.live === 0 && (first.daemon?.predecessorPids ?? []).length === 0)
}

export function hostedCallerRefusalLine(verb: 'stop' | 'restart'): string {
  return `[daemon] ${verb} refused — ${HOSTED_CALLER_REFUSAL}`
}
