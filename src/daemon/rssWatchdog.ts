import { execFile } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { platform } from 'node:os'

import { flagEnv } from '../substrate/flagRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { recordSpawnExit } from '../utils/spawnLedger.js'

export const RSS_SWEEP_INTERVAL_MS = 60_000

export function childRssLimitMb(): number | null {
  const raw = flagEnv('MERCURY_CHILD_RSS_LIMIT_MB')
  if (raw === undefined || raw.trim() === '') return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function parsePsRss(output: string): Map<number, number> {
  const rssByPid = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    rssByPid.set(Number(match[1]), Number(match[2]))
  }
  return rssByPid
}

export interface RssBreach {
  short: string
  pid: number
  rssMb: number
}

export function decideRssBreaches(
  children: ReadonlyArray<{ short: string; pid?: number; settled: boolean }>,
  rssByPid: ReadonlyMap<number, number>,
  limitMb: number,
): RssBreach[] {
  const breaches: RssBreach[] = []
  for (const child of children) {
    if (child.settled || child.pid === undefined) continue
    const rssKb = rssByPid.get(child.pid)
    if (rssKb === undefined) continue
    const rssMb = rssKb / 1024
    if (rssMb > limitMb) breaches.push({ short: child.short, pid: child.pid, rssMb: Math.round(rssMb) })
  }
  return breaches
}

interface WatchedRoster {
  list(): ReadonlyArray<{ short: string; pid?: number; outcome?: string }>
  kill(short: string, signal?: NodeJS.Signals): boolean
}

export function armChildRssWatchdog(roster: WatchedRoster): () => void {
  const limitMb = childRssLimitMb()
  if (limitMb === null) return () => {}
  if (platform() === 'win32') {
    logForDebugging('[daemon] MERCURY_CHILD_RSS_LIMIT_MB is set but the RSS watchdog has no win32 reader yet — inert')
    return () => {}
  }
  const sweep = (): void => {
    const live = roster.list().filter(entry => !entry.outcome && entry.pid !== undefined)
    if (live.length === 0) return
    const pids = live.map(entry => String(entry.pid))
    execFile('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { windowsHide: true, timeout: 5_000, env: { ...subprocessEnv() } }, (error, stdout) => {
      const rssByPid = parsePsRss(stdout ?? '')
      if (error && rssByPid.size === 0) return
      const breaches = decideRssBreaches(
        live.map(entry => ({ short: entry.short, pid: entry.pid, settled: Boolean(entry.outcome) })),
        rssByPid,
        limitMb,
      )
      for (const breach of breaches) {
        // eslint-disable-next-line no-console
        console.error(
          `[daemon] worker ${breach.short} (pid ${breach.pid}) crossed the operator's memory limit: ${breach.rssMb}MB > ${limitMb}MB (MERCURY_CHILD_RSS_LIMIT_MB) — stopping it; a durable session resumes by re-admission`,
        )
        recordSpawnExit({
          kind: 'long-lived',
          event: 'reap',
          id: breach.short,
          pid: breach.pid,
          outcome: 'rss-limit',
          reason: `rss ${breach.rssMb}MB > limit ${limitMb}MB`,
        })
        roster.kill(breach.short)
      }
    })
  }
  const timer = setInterval(sweep, RSS_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
