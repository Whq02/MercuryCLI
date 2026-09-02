import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

export type DaemonVerb =
  | { kind: 'run'; args: string[] }
  | { kind: 'status' }
  | { kind: 'stop'; args: string[] }
  | { kind: 'restart' }
  | { kind: 'help' }
  | { kind: 'unknown'; word: string }

export const DAEMON_USAGE = [
  'usage: mercury daemon [run [dir] | status | stop [--keep|--any] | restart | --help]',
  '  (bare)          start the supervisor for the current folder (same as run)',
  '  run [dir]       start the supervisor scheduling for dir (default: the current folder)',
  '  status          probe the running supervisor and print its state',
  '  stop [--keep|--any]  ask the supervisor to shut down (--keep leaves in-flight workers running; --any reaps them — the default)',
  '  restart         re-execute the daemon as the deployed build when idle',
].join('\n')

const defaultIsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function looksLikeDirectoryArg(word: string, isDir: (p: string) => boolean = defaultIsDir): boolean {
  if (word.startsWith('-')) return false
  if (isAbsolute(word) || /^[A-Za-z]:[\\/]/.test(word)) return true
  if (word.includes('/') || word.includes('\\')) return true
  return isDir(word)
}

export function parseDaemonVerb(args: readonly string[], isDir: (p: string) => boolean = defaultIsDir): DaemonVerb {
  const first = args[0]
  if (first === undefined) return { kind: 'run', args: [] }
  switch (first) {
    case 'run':
      return { kind: 'run', args: args.slice(1) }
    case 'status':
      return { kind: 'status' }
    case 'stop':
      return { kind: 'stop', args: args.slice(1) }
    case 'restart':
      return { kind: 'restart' }
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' }
    default:
      return looksLikeDirectoryArg(first, isDir) ? { kind: 'run', args: [...args] } : { kind: 'unknown', word: first }
  }
}

export function startTokenEpochMs(token: string): number | null {
  const trimmed = token.trim()
  if (trimmed === '') return null
  const cim = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-](?:\d{1,4}|\*{3}))?$/.exec(trimmed)
  if (cim) {
    const [, y, mo, d, h, mi, s, frac, off] = cim
    const utcMs = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      frac ? Math.round(Number(`0.${frac}`) * 1000) : 0,
    )
    if (Number.isNaN(utcMs)) return null
    const offsetMin = off === undefined || off.includes('*') ? 0 : Number(off)
    if (Number.isNaN(offsetMin)) return null
    return utcMs - offsetMin * 60_000
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

export const START_TOKEN_SKEW_MS = 5_000

export type StaleStopVerdict = 'sweep-recycled' | 'alive-refuse' | 'unknown-refuse'

export function staleStopVerdict(recordStartedAtMs: number, liveTokenEpochMs: number | null): StaleStopVerdict {
  if (liveTokenEpochMs === null) return 'unknown-refuse'
  return liveTokenEpochMs > recordStartedAtMs + START_TOKEN_SKEW_MS ? 'sweep-recycled' : 'alive-refuse'
}

export type SupervisorIdentityVerdict = 'same-process' | 'not-recorded-process' | 'unknown'

export function supervisorRecordIdentity(
  rec: { startedAt: number; startToken?: string | null },
  liveToken: string | null,
): SupervisorIdentityVerdict {
  if (typeof rec.startToken === 'string' && rec.startToken !== '') {
    if (liveToken === null) return 'unknown'
    return liveToken === rec.startToken ? 'same-process' : 'not-recorded-process'
  }
  const fallback = staleStopVerdict(rec.startedAt, startTokenEpochMs(liveToken ?? ''))
  if (fallback === 'sweep-recycled') return 'not-recorded-process'
  return fallback === 'alive-refuse' ? 'same-process' : 'unknown'
}
