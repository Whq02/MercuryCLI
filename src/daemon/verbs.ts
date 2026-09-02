// ============================================================================
//  daemon/verbs — the `mercury daemon <verb>` grammar, pure.
//
//  Before this owner every unrecognised word fell through to the supervisor
//  with the word as its scheduling directory: `mercury daemon --help` started
//  the scheduler in the operator's console, `mercury daemon start` aimed it at
//  a phantom `./start` (TASK-014 w5-f01-02 / f02-04 / f05-04). The grammar:
//    (bare)            run for the current folder — kept for cron entries
//    run [dir]         the supervisor for dir (the product's own spawn shape)
//    <dir>             an absolute, separator-bearing or EXISTING directory
//                      positional is still `run <dir>` (documented back-compat)
//    status · stop [--keep] · restart
//    help · --help · -h
//    anything else     refused with the usage — never a silent supervisor start
// ============================================================================
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

/** A positional that reads as a directory, not a verb: absolute, carrying a
 *  separator (either kind — a Windows spelling reaches a POSIX parse in the
 *  provers), or an existing directory by that bare name. */
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

/**
 * Epoch-ms reading of a process START token, both platform dialects: the
 * win32 CIM CreationDate (`yyyymmddHHMMSS.ffffff±UUU`, local time with the
 * offset in MINUTES; `+***` when the zone is unknown) and the POSIX
 * `ps -o lstart=` form (`Wed Aug 27 09:30:12 2026`, local, V8-parseable).
 * Null = unreadable — the caller must treat identity as UNKNOWN, never as
 * a verdict.
 */
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

/** Identity skew: the supervisor's process is CREATED before it stamps
 *  startedAt (spawn latency, seconds under load), and both token dialects
 *  carry second precision — so a creation reading AFTER the stamp plus this
 *  skew can only be a DIFFERENT process on a recycled pid. */
export const START_TOKEN_SKEW_MS = 5_000

export type StaleStopVerdict = 'sweep-recycled' | 'alive-refuse' | 'unknown-refuse'

/**
 * The ENOCONN stop's alive-pid decision — identity beyond the pid
 * (a conceded Windows shape): Windows recycles pids
 * fast, and "end that process by hand" against a recycled pid aims the
 * operator at an innocent process. A live process born AFTER the record's
 * startedAt (plus skew) is a recycled pid — the supervisor is gone and the
 * record sweeps; born at-or-before, it IS the recorded supervisor — refuse
 * with the live line; an unreadable token refuses UNKNOWN, and that arm
 * must never prescribe a by-hand kill.
 */
export function staleStopVerdict(recordStartedAtMs: number, liveTokenEpochMs: number | null): StaleStopVerdict {
  if (liveTokenEpochMs === null) return 'unknown-refuse'
  return liveTokenEpochMs > recordStartedAtMs + START_TOKEN_SKEW_MS ? 'sweep-recycled' : 'alive-refuse'
}

export type SupervisorIdentityVerdict = 'same-process' | 'not-recorded-process' | 'unknown'

/**
 * THE ONE IDENTITY OWNER (the D-convergence union, lead-ruled): is the live
 * process holding a supervisor record's pid still THE recorded daemon? Both
 * judgment sites — the boot reconcile (reconcileRecords.ts) and the ENOCONN
 * stop arm (main.ts) — consult THIS function and nothing else, so the tree
 * can never hold two competing liveness judgments again.
 *
 *   · THE BASELINE ARM: a record carrying its own startToken (every record
 *     written since the F-1 fold stamps one at boot) is judged by
 *     byte-equality against the live token — exact, no parsing, no skew.
 *     A null live token (probe glitch) is unknown; anything else unequal —
 *     a different token, or '' for a pid that died inside the probe
 *     window — is NOT the recorded process.
 *   · THE FALLBACK ARM — RETIREMENT: this arm exists only while records
 *     written BEFORE the startToken stamp can exist; one daemon generation
 *     after the fleet's floor passes that fold, delete it and let a
 *     missing baseline read 'unknown'. The verifier's birth-time judgment
 *     (dispute D as landed): the live token parsed to an epoch against the
 *     record's startedAt plus the skew — born after is a recycled pid,
 *     born at-or-before is the recorded supervisor, unparseable is
 *     unknown.
 *
 * Callers gate on pid-liveness FIRST (a dead pid needs no identity) and on
 * the control-socket ping LAST (a serving daemon outranks every record
 * judgment) — this function judges identity alone.
 */
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
