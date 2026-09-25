import { getAncestorPidsAsync } from '../utils/genericProcessUtils.js'
import { parseWorkerParentPid } from './workerParentWatch.js'

export const HOSTED_CALLER_REFUSAL = 'run it from a plain shell; from inside a hosted session your own turn would end'

export type HostedCallerRoad = 'stamp' | 'ancestry'

export type HostedCallerVerdict = { hosted: false } | { hosted: true; daemonPid: number; road: HostedCallerRoad }

export type HostedCallerFacts = { ancestors: readonly number[]; workerParentPid: number | null }

const usablePid = (pid: number | null | undefined): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 1

export function hostedCallerVerdict(daemonPid: number | null | undefined, facts: HostedCallerFacts): HostedCallerVerdict {
  if (!usablePid(daemonPid)) return { hosted: false }
  if (facts.workerParentPid === daemonPid) return { hosted: true, daemonPid, road: 'stamp' }
  if (facts.ancestors.includes(daemonPid)) return { hosted: true, daemonPid, road: 'ancestry' }
  return { hosted: false }
}

export async function hostedCallerOf(
  daemonPid: number | null | undefined,
  opts: { pid?: number; env?: NodeJS.ProcessEnv; ancestors?: (pid: number) => Promise<number[]> } = {},
): Promise<HostedCallerVerdict> {
  if (!usablePid(daemonPid)) return { hosted: false }
  const workerParentPid = parseWorkerParentPid(opts.env ?? process.env)
  if (workerParentPid === daemonPid) return { hosted: true, daemonPid, road: 'stamp' }
  const ancestors = await (opts.ancestors ?? getAncestorPidsAsync)(opts.pid ?? process.pid)
  return hostedCallerVerdict(daemonPid, { ancestors, workerParentPid })
}

export function hostedCallerRefusalLine(verb: 'stop' | 'restart'): string {
  return `[daemon] ${verb} refused — ${HOSTED_CALLER_REFUSAL}`
}
