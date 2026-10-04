import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

export type DaemonVerb =
  | { kind: 'run'; args: string[] }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'restart' }
  | { kind: 'help' }
  | { kind: 'unknown'; word: string }
  | { kind: 'unknown-flag'; verb: 'stop'; word: string }

export const DAEMON_USAGE = [
  'Usage: mercury daemon [options] [command]',
  '',
  'The background process that hosts your sessions and runs scheduled jobs',
  '(the daemon); bare `mercury daemon` is `run`',
  '',
  'Options:',
  '  -h, --help  Show help',
  '',
  'Commands:',
  '  run [dir]   Start the daemon for dir (default: the current folder)',
  '  status      Probe the running daemon and print its state',
  '  stop        Ask the daemon to shut down; every session process it runs',
  '              (every worker) stops with it',
  '  restart     Re-execute the daemon, once idle, as the Mercury build now',
  '              installed (the deployed build)',
].join('\n')

const defaultIsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const SCREEN_HEAL_ASK = /^screen \d+$/

export function isScreenHealAsk(by: string): boolean {
  return SCREEN_HEAL_ASK.test(by)
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
      return args.length === 1 ? { kind: 'stop' } : { kind: 'unknown-flag', verb: 'stop', word: args[1] ?? '' }
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
