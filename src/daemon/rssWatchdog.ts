import { execFile } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { platform } from 'node:os'

import { flagEnv } from '../substrate/flagRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { recordSpawnExit } from '../utils/spawnLedger.js'

export const RSS_SWEEP_INTERVAL_MS = 60_000
export const DEFAULT_CHILD_RSS_LIMIT_MB = 1536

export function childRssLimitMb(): number | null {
  const raw = flagEnv('MERCURY_CHILD_RSS_LIMIT_MB')
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHILD_RSS_LIMIT_MB
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CHILD_RSS_LIMIT_MB
  return parsed > 0 ? parsed : null
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

export type RssBreachVerb = 'park' | 'park-after-turn' | 'kill' | 'defer'

export interface RssBreach {
  short: string
  pid: number
  rssMb: number
  verb: RssBreachVerb
}

export interface RssWatchedChild {
  short: string
  pid?: number
  settled: boolean
  turnOpen?: boolean
  sessionId?: string
}

export function decideRssBreaches(
  children: ReadonlyArray<RssWatchedChild>,
  rssByPid: ReadonlyMap<number, number>,
  limitMb: number,
): RssBreach[] {
  const breaches: RssBreach[] = []
  for (const child of children) {
    if (child.settled || child.pid === undefined) continue
    const rssKb = rssByPid.get(child.pid)
    if (rssKb === undefined) continue
    const rssMb = rssKb / 1024
    if (rssMb <= limitMb) continue
    const verb: RssBreachVerb = child.sessionId === undefined ? (child.turnOpen === true ? 'defer' : 'kill') : child.turnOpen === true ? 'park-after-turn' : 'park'
    breaches.push({ short: child.short, pid: child.pid, rssMb: Math.round(rssMb), verb })
  }
  return breaches
}

export interface RssGuardRoster {
  list(): ReadonlyArray<{ short: string; pid?: number; outcome?: string; turnActive?: boolean }>
  kill(short: string, signal?: NodeJS.Signals): boolean
}

export interface RssGuardSeats {
  sessionOf(short: string): string | undefined
  park(sessionId: string, reason: string, afterTurn: boolean): Promise<{ outcome: string; detail?: string }>
}

export function memoryParkReason(rssMb: number, limitMb: number): string {
  return `parked — over the memory limit (${rssMb}MB > ${limitMb}MB) · ↵ resumes`
}

export type RssReader = (pids: number[]) => Promise<Map<number, number>>

const psReader: RssReader = pids =>
  new Promise(resolve => {
    execFile('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { windowsHide: true, timeout: 5_000, env: { ...subprocessEnv() } }, (error, stdout) => {
      const rssByPid = parsePsRss(stdout ?? '')
      resolve(error && rssByPid.size === 0 ? new Map() : rssByPid)
    })
  })

export function runRssSweep(
  roster: RssGuardRoster,
  seats: RssGuardSeats | undefined,
  limitMb: number,
  readRss: RssReader,
  parking: Set<string>,
): Promise<RssBreach[]> {
  const live = roster.list().filter(entry => !entry.outcome && entry.pid !== undefined)
  if (live.length === 0) return Promise.resolve([])
  return readRss(live.map(entry => entry.pid as number)).then(rssByPid => {
    const breaches = decideRssBreaches(
      live.map(entry => ({
        short: entry.short,
        pid: entry.pid,
        settled: Boolean(entry.outcome),
        turnOpen: entry.turnActive === true,
        sessionId: seats?.sessionOf(entry.short),
      })),
      rssByPid,
      limitMb,
    )
    for (const breach of breaches) {
      if (parking.has(breach.short)) continue
      const words = `${breach.rssMb}MB > ${limitMb}MB (MERCURY_CHILD_RSS_LIMIT_MB)`
      if (breach.verb === 'defer') {
        // eslint-disable-next-line no-console
        console.error(`[daemon] worker ${breach.short} (pid ${breach.pid}) crossed the operator's memory limit: ${words} — its turn is open, so it is left to finish; the next sweep reads it again`)
        continue
      }
      if (breach.verb === 'kill' || seats === undefined) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] worker ${breach.short} (pid ${breach.pid}) crossed the operator's memory limit: ${words} — stopping it; a durable session resumes by re-admission`)
        recordSpawnExit({ kind: 'long-lived', event: 'reap', id: breach.short, pid: breach.pid, outcome: 'rss-limit', reason: `rss ${breach.rssMb}MB > limit ${limitMb}MB` })
        roster.kill(breach.short)
        continue
      }
      const sessionId = seats.sessionOf(breach.short)
      if (sessionId === undefined) continue
      const afterTurn = breach.verb === 'park-after-turn'
      // eslint-disable-next-line no-console
      console.error(`[daemon] worker ${breach.short} (pid ${breach.pid}) crossed the operator's memory limit: ${words} — parking its session${afterTurn ? ' after its turn' : ''}; ↵ on the row resumes it`)
      parking.add(breach.short)
      void seats
        .park(sessionId, memoryParkReason(breach.rssMb, limitMb), afterTurn)
        .then(result => {
          recordSpawnExit({ kind: 'long-lived', event: 'reap', id: breach.short, pid: breach.pid, outcome: result.outcome === 'parked' || result.outcome === 'applied' ? 'rss-limit-parked' : result.outcome === 'draining' ? 'rss-limit-draining' : 'rss-limit-refused', reason: `rss ${breach.rssMb}MB > limit ${limitMb}MB${result.detail !== undefined ? ` · ${result.detail}` : ''}` })
          if (result.outcome === 'refused') {
            // eslint-disable-next-line no-console
            console.error(`[daemon] worker ${breach.short} over the memory limit could not be parked: ${result.detail ?? result.outcome} — left running; the next sweep asks again`)
          }
        })
        .finally(() => parking.delete(breach.short))
    }
    return breaches
  })
}

export function armChildRssWatchdog(roster: RssGuardRoster, seats?: RssGuardSeats, readRss: RssReader = psReader): () => void {
  const limitMb = childRssLimitMb()
  if (limitMb === null) return () => {}
  if (platform() === 'win32') {
    logForDebugging('[daemon] MERCURY_CHILD_RSS_LIMIT_MB is set but the RSS watchdog has no win32 reader yet — inert')
    return () => {}
  }
  const parking = new Set<string>()
  const timer = setInterval(() => void runRssSweep(roster, seats, limitMb, readRss, parking), RSS_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
