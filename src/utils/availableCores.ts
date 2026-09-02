/**
 * The ONE core-count owner for concurrency sizing (sweep #2, A13).
 * `os.cpus().length` is the HOST's core count; inside a container or a CI
 * runner with a cgroup CPU quota the process may own a fraction of it, and
 * sizing fan-out from the host number oversubscribes the quota — every lane
 * crawls. The answer here is the host count bounded by the cgroup quota
 * (v2 `cpu.max`, v1 `cpu.cfs_quota_us`/`cpu.cfs_period_us`) and by the
 * scheduler affinity the runtime reports; never below one. Every seam that
 * sizes a pool reads this (law 6).
 */
import { readFileSync } from 'node:fs'
import { availableParallelism, cpus, platform } from 'node:os'

const CGROUP_V2_CPU_MAX = '/sys/fs/cgroup/cpu.max'
const CGROUP_V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us'
const CGROUP_V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us'

/**
 * Pure: cores implied by a cgroup quota, or null when no quota applies.
 * v2 text is "<quota> <period>" or "max <period>"; v1 quota -1 means none.
 */
export function coresFromCgroupQuota(input: {
  cpuMaxText?: string | null
  cfsQuotaUs?: string | null
  cfsPeriodUs?: string | null
}): number | null {
  const v2 = input.cpuMaxText?.trim()
  if (v2) {
    const [quotaRaw, periodRaw] = v2.split(/\s+/)
    if (quotaRaw !== undefined && quotaRaw !== 'max') {
      const quota = Number(quotaRaw)
      const period = Number(periodRaw ?? '100000')
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
        return Math.max(1, Math.ceil(quota / period))
      }
    }
    return null
  }
  const quota = Number(input.cfsQuotaUs?.trim())
  const period = Number(input.cfsPeriodUs?.trim())
  if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
    return Math.max(1, Math.ceil(quota / period))
  }
  return null
}

/** Pure: the final answer from its three facts. */
export function resolveAvailableCores(facts: { hostCores: number; affinityCores?: number | null; quotaCores: number | null }): number {
  let cores = Math.max(1, Math.floor(facts.hostCores) || 1)
  if (facts.affinityCores !== undefined && facts.affinityCores !== null && facts.affinityCores > 0) {
    cores = Math.min(cores, Math.floor(facts.affinityCores))
  }
  if (facts.quotaCores !== null && facts.quotaCores > 0) cores = Math.min(cores, facts.quotaCores)
  return Math.max(1, cores)
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

let memo: number | null = null

/** The live answer, memoized per process (a quota does not move under a
 *  running session; a fresh process re-reads). */
export function availableCores(): number {
  if (memo !== null) return memo
  const hostCores = cpus().length
  let affinityCores: number | null = null
  try {
    affinityCores = availableParallelism()
  } catch {
    affinityCores = null
  }
  const quotaCores =
    platform() === 'linux'
      ? coresFromCgroupQuota({
          cpuMaxText: readOrNull(CGROUP_V2_CPU_MAX),
          cfsQuotaUs: readOrNull(CGROUP_V1_QUOTA),
          cfsPeriodUs: readOrNull(CGROUP_V1_PERIOD),
        })
      : null
  memo = resolveAvailableCores({ hostCores, affinityCores, quotaCores })
  return memo
}

export function _resetAvailableCoresForTesting(): void {
  memo = null
}
