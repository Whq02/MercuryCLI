// ============================================================================
//  ownerWatch — owner-orphan self-reap for an AUTO-STARTED (owned) daemon.
//
//  The daemon that spawnOwnedDaemon starts is DETACHED. The parent-side reaper
//  (process.once('exit')) does NOT fire on SIGHUP (terminal close) or SIGKILL —
//  PROVEN empirically — so closing the CLI would orphan the daemon (it kept
//  running across sessions, which also let it route its workers through a
//  STALE account: the daemon held whatever auth was live when it first started,
//  while the foreground later switched accounts). This is the robust backstop:
//  the auto-started daemon learns its owner's pid (the owner-pid stamp)
//  and SELF-shuts-down once the owner is
//  absent — regardless of how the owner died.
//
//  An explicitly-run `mercury daemon` carries NO owner pid ⇒ the watch never arms
//  ⇒ it persists for cron (the operator's deliberate long-lived daemon). Opt out
//  of the auto-reap with MERCURY_DAEMON_PERSIST=1 (the historical
//  spelling of the persist opt-out).
//
//  Pure + side-effect-light so it's unit-testable under `bun run` (daemon/main.ts
//  is not loadable there — heavy deps + the feature() macro).
//
//  KNOWN LIMITATION (documented, not a bug): the daemon is shared and only the
//  FIRST session that spawned it is its "owner" (an ensure no-ops when a
//  daemon is already live). If session A spawns the daemon, session B attaches,
//  then A closes, the watch reaps even though B is live. Single-session (the
//  common case) is fully correct; multi-session operators set PERSIST=1. A future
//  client-liveness lease would lift this.
// ============================================================================

import { execFile, spawnSync } from 'node:child_process'
import { procLiveToken } from '../utils/genericProcessUtils.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The env var spawnOwnedDaemon stamps with the spawning session's pid (the
 *  registry row names its consumers). */
export const OWNER_PID_ENV = 'MERCURY_DAEMON_OWNER_PID'

// Prefer pwsh (PowerShell 7 — ≈2× the 5.1 start cost) when it
// resolves; the resolution is a zero-spawn PATH scan, cached per process.
// Deliberately LOCAL (a near-twin lives in genericProcessUtils.ts): this
// module's contract is bun-run loadability with node: builtins only
// (prove-daemon-reap/bench provers load it directly), so it must not import
// the execa-backed exec wrappers.
let win32PsExeCached: string | null = null
function win32PsExe(): string {
  if (win32PsExeCached !== null) return win32PsExeCached
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map(dir => join(dir, 'pwsh.exe'))
    .find(p => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    })
  const fixed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  win32PsExeCached = fromPath ?? (existsSync(fixed) ? fixed : 'powershell.exe')
  return win32PsExeCached
}

const startTokenArgs = (pid: number): string[] => [
  '-NoProfile',
  '-Command',
  `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`,
]

/**
 * The win32 start-token VERDICT, pure — the one reading both probe forms
 * share. Vocabulary: token · '' gone · null unknown (fail safe: never a
 * death verdict from a probe that did not answer the question).
 *   · could not run (spawn error, timeout kill)        ⇒ null
 *   · non-zero exit                                    ⇒ null — the QUERY
 *     failed; that is not evidence the pid is absent
 *   · exit 0, empty stdout, text on stderr             ⇒ null — a
 *     non-terminating CIM error under -Command exits 0 and writes only to
 *     stderr; this is the broken probe that read as a dead owner and reaped
 *     a live session's daemon ~8s later (TASK-014 w5-f02-01)
 *   · exit 0, non-empty stdout                         ⇒ the token
 *   · exit 0, empty stdout, empty stderr               ⇒ '' — CIM found no
 *     such process; the ONLY gone
 */
export function win32StartTokenVerdict(probe: {
  ran: boolean
  exitCode: number | null
  stdout: string | null | undefined
  stderr: string | null | undefined
}): string | null {
  if (!probe.ran) return null
  if (probe.exitCode !== 0) return null
  const out = (probe.stdout ?? '').trim()
  if (out.length > 0) return out
  return (probe.stderr ?? '').trim().length > 0 ? null : ''
}

/**
 * The owner's process START token (`ps -o lstart=`), pinning IDENTITY beyond the
 * raw pid (R5b). Returns:
 *   - the trimmed lstart string when ps finds the pid (a stable per-process id),
 *   - '' when ps ran but the pid is ABSENT (no such process),
 *   - null when ps itself could NOT run (unknown ⇒ caller fails safe, never reaps
 *     a live pid on a probe glitch).
 * Portable across macOS + Linux (both ship `ps -o lstart=`). Cheap enough to run
 * once at watch-arm (baseline) + once per spawn-stamp. Steady-cadence PROBES and
 * render paths use the async/cached accessors below: on win32 this
 * sync form costs a full PowerShell start.
 */
export function getProcessStartToken(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      // Win32 has no `ps`; query the process CreationDate via CIM (the same idiom
      // genericProcessUtils.getProcessCommand uses for Windows). A reused pid gets
      // a different CreationDate, so this is a valid reuse-detection token —
      // without it the R5b PID-reuse guard was INERT on Windows.
      const r = spawnSync(win32PsExe(), startTokenArgs(pid), {
        encoding: 'utf-8',
        timeout: 2000,
        windowsHide: true,
        env: { ...subprocessEnv() },
      })
      return win32StartTokenVerdict({ ran: !r.error, exitCode: r.status, stdout: r.stdout, stderr: r.stderr })
    }
    // Linux answers from procfs — the SAME family the claim stamps
    // (currentProcStart), read with the process state so a zombie is gone
    // and a stopped holder is alive; ps(1) is the road only where the stat
    // file cannot be read.
    const local = procLiveToken(pid)
    if (local !== undefined && local !== null) return local
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 2000,
      env: { ...subprocessEnv() },
    })
    if (r.error) return null // ps couldn't run → unknown
    if (r.status !== 0) return '' // ps ran, pid not found → gone
    const s = (r.stdout || '').trim()
    return s.length > 0 ? s : '' // empty stdout ⇒ gone
  } catch {
    return null
  }
}

/** Async form of getProcessStartToken — the SAME verdict vocabulary as the
 *  sync form (token · '' gone · null unknown), but the event loop is never
 *  blocked (the win32 sync spawn cost 400–900ms inside the
 *  daemon's 4s probe interval). */
export function getProcessStartTokenAsync(pid: number): Promise<string | null> {
  return new Promise(resolve => {
    // ENOENT (no such exe) and a timeout kill are the could-not-probe cases
    // (⇒ null, fail safe — never a death verdict from a probe glitch); a
    // plain non-zero exit mirrors the sync form's platform reading.
    const unknownErr = (err: unknown): boolean => {
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      return e?.code === 'ENOENT' || e?.killed === true
    }
    try {
      if (process.platform === 'win32') {
        execFile(
          win32PsExe(),
          startTokenArgs(pid),
          { encoding: 'utf-8', timeout: 3000, windowsHide: true, env: { ...subprocessEnv() } },
          (err, stdout, stderr) => {
            if (err && unknownErr(err)) {
              resolve(null)
              return
            }
            // execFile's err carries the numeric exit code for a completed
            // non-zero run; the mapper reads that as "query failed", never
            // as a gone pid.
            const exitCode = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
            resolve(win32StartTokenVerdict({ ran: true, exitCode, stdout, stderr }))
          },
        )
        return
      }
      // The procfs family on linux (see the sync form) — no spawn at all.
      const local = procLiveToken(pid)
      if (local !== undefined && local !== null) {
        resolve(local)
        return
      }
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { windowsHide: true, encoding: 'utf-8', timeout: 3000, env: { ...subprocessEnv() } },
        (err, stdout) => {
          if (err && unknownErr(err)) {
            resolve(null)
            return
          }
          if (err) {
            resolve('') // ps ran, non-zero exit ⇒ pid not found ⇒ gone
            return
          }
          const s = (stdout || '').trim()
          resolve(s.length > 0 ? s : '')
        },
      )
    } catch {
      resolve(null)
    }
  })
}

// Per-PID token cache for the RENDER-path accessor: a live process's start
// token never changes, so serving a cached value is sound while the caller's
// own kill(pid, 0) says the pid is alive; maxAgeMs bounds how long a pid
// REUSE can hide behind the cache (the same window the probe cadence already
// accepts).
const startTokenCache = new Map<number, { token: string | null; at: number }>()
const startTokenInflight = new Set<number>()

/**
 * Render-path-safe token read: returns the cached token when
 * fresh, otherwise kicks ONE async refresh and returns the stale value (or
 * null = unknown on a cold miss). Callers already treat null as "cannot
 * prove reuse ⇒ assume alive", so a cold miss converges on the next read
 * without ever spawning on the render path.
 */
export function getProcessStartTokenCachedOrRefresh(pid: number, maxAgeMs = 10_000): string | null {
  const hit = startTokenCache.get(pid)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.token
  if (!startTokenInflight.has(pid)) {
    startTokenInflight.add(pid)
    void getProcessStartTokenAsync(pid)
      .then(token => {
        startTokenCache.set(pid, { token, at: Date.now() })
      })
      .finally(() => {
        startTokenInflight.delete(pid)
      })
  }
  return hit ? hit.token : null
}

/**
 * Does the owner pid STILL belong to the original owner? (R5b: closes the PID-reuse
 * window where the OS recycles the owner's pid within the ~8s grace, which the
 * pid-only `isProcessAlive` would read as "still alive" and never reap.) Pure.
 *  - no usable baseline (null/'' — ps unavailable at arm) ⇒ true (fall back to
 *    pid-liveness only; never falsely reap where ps can't help);
 *  - current==null (a probe glitch on a live pid) ⇒ true (fail safe);
 *  - else identity matches iff the start token is byte-equal (a reused pid → a
 *    different lstart → false; a gone pid → '' → false).
 */
export function ownerIdentityMatches(
  currentToken: string | null,
  baselineToken: string | null,
): boolean {
  if (baselineToken === null || baselineToken === '') return true
  if (currentToken === null) return true
  return currentToken === baselineToken
}

/** Poll cadence + grace: reap after the owner is seen gone for N consecutive
 *  checks (a small grace so a momentary probe blip / pid-reuse race can't kill a
 *  live daemon). 4s × 2 ≈ 8s after a clean close — fast, but not twitchy. */
export const OWNER_WATCH_INTERVAL_MS = 4000
export const OWNER_WATCH_GRACE_CHECKS = 2

/** Parse the owner pid the auto-start handed us, or null (⇒ explicit daemon,
 *  persist). Dual-read across the version boundary (the worker-parent-pid
 *  pattern): a PRE-migration session stamps only the legacy spelling, and an
 *  unarmed owner-watch means the daemon outlives its dead owner. */
export function parseOwnerPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[OWNER_PID_ENV] ?? env.MERCURY_DAEMON_OWNER_PID)?.trim()
  if (!raw) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** Is a process alive? signal 0 probes without delivering. ESRCH ⇒ gone; EPERM ⇒
 *  alive but not ours (still alive). Any other error ⇒ treat as alive (fail safe:
 *  never reap on an ambiguous probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Decide whether an owner-watched daemon should self-reap. Pure.
 *  - persist=true (MERCURY_DAEMON_PERSIST) ⇒ never.
 *  - ownerPid===null (explicit `mercury daemon`) ⇒ never.
 *  - owner still alive ⇒ never.
 *  - owner gone for >= graceChecks consecutive probes ⇒ reap.
 */
export function decideOrphanShutdown(args: {
  ownerPid: number | null
  ownerAlive: boolean
  deadStreak: number
  graceChecks: number
  persist: boolean
}): boolean {
  if (args.persist) return false
  if (args.ownerPid === null) return false
  if (args.ownerAlive) return false
  return args.deadStreak >= args.graceChecks
}
