// ============================================================================
//  ownedDaemon — the ONE owned-daemon spawn seam (extracted so no auto-start drifts).
//
//  An "owned" daemon is a detached `mercury daemon` auto-started by a foreground
//  session that should NOT outlive that session. The reaping is two-layered:
//    (1) parent-side fast-path — process.once('exit') + a SIGHUP handler reap it
//        the instant the owner exits cleanly / the terminal closes; and
//    (2) the daemon-side owner-watch (ownerWatch.ts) — the robust backstop that
//        self-reaps even on the owner's SIGKILL/crash, keyed on the owner-pid
//        stamp (MERCURY_SCRIBE_OWNER_PID — the env keeps its historical spelling).
//  BOTH layers key on the owner pid this seam STAMPS. Every auto-start (the
//  crew engage, the switchboard's ensure, the concourse route, the handshake
//  restart) routes through here, so none can orphan — a detached daemon spawned
//  with NEITHER layer (no owner pid, no reaper) leaks its daemon + workers on
//  every exit. One seam = one place to keep reaping airtight (extend via the
//  seam, never beside it).
//
//  An explicitly-run `mercury daemon` carries no owner pid ⇒ the daemon-side
//  owner-watch never arms ⇒ it persists for cron. Opt out of the parent reaper with
//  MERCURY_SCRIBE_DAEMON_PERSIST=1 (the historical spelling of the persist
//  opt-out; the daemon-side owner-watch still self-reaps).
// ============================================================================
import { adoptiveProjectPath } from '../utils/projectStoreAdoption.js'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithWin32RetrySync } from '../substrate/durablePublish.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { hasStoredOAuthToken } from '../utils/auth.js'
import { STORED_TOKEN_SCRUB_VARS } from '../utils/subprocessEnv.js'
import { OWNER_PID_ENV } from './ownerWatch.js'
import { flagEnv, flagPair } from '../substrate/flagRegistry.js'

/**
 * Pure: should a daemon WE auto-started be reaped on the originating session's exit?
 * Yes by default (the orphaned detached daemon otherwise lingers); opt into
 * persistence with MERCURY_SCRIBE_DAEMON_PERSIST=1.
 */
export function shouldReapAutoStartedDaemon(persistEnv: string | undefined): boolean {
  return persistEnv !== '1'
}

// One reaper PER OWNED DAEMON this process spawns. We only ever reap a daemon WE
// just spawned, so an explicitly-run `mercury daemon` (kept for cron) is never touched.
// Tracked in a Set (not a single scalar) so a session that auto-starts more than one
// owned daemon parent-reaps every one of them, not just the first; re-arming
// the same pid is a no-op.
//
// CORRECTION (measured): process.once('exit') does NOT fire on SIGHUP (terminal
// close) or SIGTERM — only on a graceful process.exit()/event-loop drain. So we also
// catch SIGHUP for an instant reap on close. A SIGKILL/crash of the owner can't be
// caught here — that is exactly what the daemon-side owner-watch (ownerWatch.ts) backstops.
//
// The SIGHUP handler ONLY reaps — it must NOT call process.exit() itself. The global
// SIGHUP handler that setupGracefulShutdown() registered at init owns the process exit
// (gracefulShutdown(129) → terminal cleanup + resume hint + exit code 129); a bare
// process.exit(0) here would preempt that async cleanup and clobber the 129. Our
// process.once('exit', reap) still fires when that path's forceExit() calls process.exit,
// so the daemon is reaped either way — this SIGHUP arm just kills it sooner.
// RESPAWN BREAKER: a daemon that dies at
// boot + per-probe ensure* callers = an unbounded spawn loop — a visible
// console flash per spawn on win32 pre-windowsHide, wasted spawns
// everywhere. Per label: a minimum gap between spawns and a session cap;
// past either, the engage DEGRADES loudly to the debug log (read
// <project>/.mercury/daemon/daemon.log for the boot crash) instead of
// looping. Pure decision so the prover drives it.
export const OWNED_SPAWN_COOLDOWN_MS = 30_000
export const OWNED_SPAWN_SESSION_CAP = 5

export interface OwnedSpawnHistory {
  lastAt: number
  count: number
}

/** Pure: may a new owned-daemon spawn fire for this label right now? */
export function decideOwnedSpawn(
  history: OwnedSpawnHistory | undefined,
  now: number,
  cooldownMs = OWNED_SPAWN_COOLDOWN_MS,
  cap = OWNED_SPAWN_SESSION_CAP,
): 'spawn' | 'cooldown' | 'capped' {
  if (!history) return 'spawn'
  if (history.count >= cap) return 'capped'
  if (now - history.lastAt < cooldownMs) return 'cooldown'
  return 'spawn'
}

const spawnHistory = new Map<string, OwnedSpawnHistory>()

/** Test/teardown: forget the per-label breaker state. */
export function resetOwnedDaemonBreakerForTesting(): void {
  spawnHistory.clear()
}

/** What the parent-side reaper should do for an owned daemon at quit. PURE.
 *
 *  On win32 `process.kill(pid, 'SIGTERM')` is an unconditional
 *  TerminateProcess — the signal name is ignored and NO handler in the
 *  daemon runs, so nothing is parked, the roster reap never fires, and the
 *  seats' own build/test/dev-server children are orphaned permanently
 *  (FN-015 rank 11). The graceful ask goes first there; the hard kill stays
 *  as the backstop for a daemon that did not settle, or a death too abrupt
 *  for any ask to have run. POSIX keeps its signal road exactly as it was:
 *  SIGTERM there IS delivered, and the daemon's own handler runs its
 *  teardown. */
export function decideDaemonReap(facts: {
  platform: NodeJS.Platform
  gracefulAsked: boolean
  stillAlive: boolean
}): 'already-down' | 'signal' | 'hard-kill' {
  if (!facts.stillAlive) return 'already-down'
  return facts.platform === 'win32' ? 'hard-kill' : 'signal'
}

/** Is this pid still around? Signal 0 delivers nothing but reports existence. */
function daemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Ask an owned daemon to shut down through its control socket and wait,
 * BOUNDED, for it to go. `reapWorkers` is asked for by name: the seats go
 * down with their supervisor instead of surviving ~8s on their own parent
 * watch and leaving through a bare exit that runs no cleanup. The road the
 * restart-when-idle path already showed; never throws.
 */
export async function shutdownOwnedDaemonGracefully(
  pid: number,
  opts?: {
    rpc?: (req: { op: 'shutdown'; reapWorkers: boolean }, o: { timeoutMs: number }) => Promise<unknown>
    alive?: (pid: number) => boolean
    waitMs?: number
  },
): Promise<'settled' | 'unsettled'> {
  const alive = opts?.alive ?? daemonAlive
  const waitMs = opts?.waitMs ?? DAEMON_GRACEFUL_WAIT_MS
  const rpc =
    opts?.rpc ??
    (async (req, o) => {
      const { daemonControlRpc } = await import('./controlSocket.js')
      return daemonControlRpc(req as never, o)
    })
  try {
    await rpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: Math.min(waitMs, 2000) })
  } catch {
    /* unreachable or refused — the wait below tells the truth either way */
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return 'settled'
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return alive(pid) ? 'unsettled' : 'settled'
}

/** The bounded window the graceful ask gets before the backstop takes over.
 *  Sits inside the shutdown path's own cleanup cap. */
export const DAEMON_GRACEFUL_WAIT_MS = 1_500

const reapedPids = new Set<number>()
function reapDaemonOnSessionExit(pid: number): void {
  if (reapedPids.has(pid)) return
  reapedPids.add(pid)
  let gracefulAsked = false
  // THE FIRST ROAD (win32): an async cleanup, so the ordinary quit runs it
  // before any exit hook fires — the graceful shutdown path awaits the
  // cleanup registry. A crash or a kill too abrupt for this leaves the sync
  // hooks below as they always were.
  if (process.platform === 'win32') {
    registerCleanup(async () => {
      if (!daemonAlive(pid)) return
      gracefulAsked = true
      const outcome = await shutdownOwnedDaemonGracefully(pid)
      logForDebugging(`[daemon] the owned daemon (pid ${pid}) was asked to shut down: ${outcome}`)
    })
  }
  const reap = (): void => {
    const verdict = decideDaemonReap({
      platform: process.platform,
      gracefulAsked,
      stillAlive: daemonAlive(pid),
    })
    if (verdict === 'already-down') return
    try {
      // win32 ignores the name — this IS the hard kill, and it is the
      // BACKSTOP now, not the first road.
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone — fine */
    }
  }
  process.once('exit', reap)
  process.once('SIGHUP', reap)
}

/**
 * Re-arm the parent-side reaper on a daemon this process OWNS but did not
 * spawn: the successor of a restart-when-idle carries our owner-pid stamp
 * (the daemon-side watch already reaps it within its grace), and this puts
 * the exit/SIGHUP fast path back on it too. Idempotent per pid; honours the
 * persist opt-out like the spawn seam.
 */
export function adoptOwnedDaemonPid(pid: number): void {
  if (!shouldReapAutoStartedDaemon(flagEnv('MERCURY_SCRIBE_DAEMON_PERSIST'))) return
  reapDaemonOnSessionExit(pid)
}

// The label of the owned daemon THIS process most recently spawned (null =
// none this session). Transition seams consult it: an 'already-live' daemon
// that THIS session itself stood up is safe to replace with a successor — any
// other live daemon (a different session's owned daemon on the same repo, or
// an explicit persistent `mercury daemon`) is foreign and never touched.
let ownedSpawnLabelThisProcess: string | null = null

/** The label this process last spawned an owned daemon under, or null. */
export function ownedDaemonLabelThisProcess(): string | null {
  return ownedSpawnLabelThisProcess
}

// The env-kept residual (ruled): true
// when THIS process spawned an owned daemon whose gate KEPT the env bearer
// (no stored token existed at spawn, and a scrub-set var was present) — the
// daemon then serves on the spawner's env credential for its whole life.
let envKeptAuthAtSpawn = false
// One-shot: the FIRST sign-in landing asks once; later re-auths never loop
// the restart (latched before the ask, so even a refused ask never repeats).
let freshSigninRestartAsked = false

/** Proof seam — resets + optionally plants the env-kept spawn record (and
 *  the spawn label, so the trigger's guards drive without a live spawn). */
export function __resetOwnedDaemonFreshSigninForTest(opts?: {
  envKeptAuthAtSpawn?: boolean
  spawnLabel?: string | null
}): void {
  envKeptAuthAtSpawn = opts?.envKeptAuthAtSpawn ?? false
  freshSigninRestartAsked = false
  if (opts?.spawnLabel !== undefined) ownedSpawnLabelThisProcess = opts.spawnLabel
}

/**
 * The FIRST sign-in landing after an env-kept owned-daemon spawn asks that
 * daemon to restart-when-idle: the successor's spawn re-runs the gated
 * scrub with the stored token now present, so the daemon re-resolves the
 * operator's chosen account instead of serving the spawn-time env bearer
 * for its multi-day life (cross-account misattribution on a shared home).
 * Self-guarded: a no-daemon session, a stored-token spawn, an unlanded
 * sign-in, or an already-asked latch all answer 'not-applicable'. The ask
 * itself is at-idle (never interrupts held work) and RECEIPTED — the
 * daemon's log names this reason via the op's `by` string.
 */
export async function restartOwnedDaemonForFreshSignin(opts?: {
  /** Proof seam: the control rpc (defaults to the live socket road). */
  rpc?: (req: { op: 'restart-when-idle'; proto: number; by: string }, o: { timeoutMs: number }) => Promise<unknown>
}): Promise<'asked' | 'not-applicable'> {
  if (!envKeptAuthAtSpawn || freshSigninRestartAsked) return 'not-applicable'
  if (ownedSpawnLabelThisProcess === null) return 'not-applicable'
  if (!hasStoredOAuthToken()) return 'not-applicable'
  freshSigninRestartAsked = true
  const rpc =
    opts?.rpc ??
    (async (req, o) => {
      const { daemonControlRpc } = await import('./controlSocket.js')
      return daemonControlRpc(req, o)
    })
  const { MERCURY_DAEMON_PROTO } = await import('./protocol.js')
  await rpc(
    {
      op: 'restart-when-idle',
      proto: MERCURY_DAEMON_PROTO,
      by: 'fresh sign-in after an env-kept spawn — the successor re-runs the credential scrub',
    },
    { timeoutMs: 3000 },
  ).catch(() => undefined) // best-effort: a refused/unreachable ask never disturbs the sign-in
  return 'asked'
}

/**
 * Spawn an OWNED detached `mercury daemon projectDir`: stamp the owner pid (so the
 * daemon-side owner-watch self-reaps when this session dies) and arm the parent-side
 * exit/SIGHUP reaper fast-path (unless persisting). `extraEnv` overlays the spawn env
 * (a value of `undefined` DELETES that key, so a caller can force-clear an inherited
 * var). Returns the child pid, or undefined if it could not be spawned. Never throws.
 */
export function spawnOwnedDaemon(
  projectDir: string,
  opts?: { label?: string; extraEnv?: Record<string, string | undefined>; persist?: boolean },
): number | undefined {
  const label = opts?.label ?? 'daemon'
  const script = process.argv[1]
  if (!script) {
    logForDebugging(`[${label}] spawnOwnedDaemon: no process.argv[1]; cannot spawn daemon`)
    return undefined
  }
  // The respawn breaker: a boot-crashing daemon must never spawn-loop.
  const now = Date.now()
  const history = spawnHistory.get(label)
  const verdict = decideOwnedSpawn(history, now)
  if (verdict !== 'spawn') {
    logForDebugging(
      verdict === 'capped'
        ? `[${label}] spawnOwnedDaemon: session cap ${OWNED_SPAWN_SESSION_CAP} reached — the daemon keeps dying at boot; read ${join(adoptiveProjectPath(projectDir, 'daemon'), 'daemon.log')}`
        : `[${label}] spawnOwnedDaemon: cooling down (${Math.round((now - (history?.lastAt ?? 0)) / 1000)}s since the last spawn) — skipped`,
    )
    return undefined
  }
  spawnHistory.set(label, { lastAt: now, count: (history?.count ?? 0) + 1 })
  try {
    // BOTH spellings (the mixed-version window): a PRE-migration daemon
    // binary reads only the legacy owner-pid spelling — a one-spelling stamp
    // would leave its self-reap watch unarmed and orphan the daemon.
    // child-env law: raw base by design — the daemon IS Mercury; the gated
    // scrub below strips the pinned token vars (HB-0078).
    const env: NodeJS.ProcessEnv = { ...process.env, ...flagPair(OWNER_PID_ENV, String(process.pid)) }
    // STORE-IDENTITY GATING: the daemon's
    // mailbox/teams/config surface all resolve through the config-home pin,
    // and an owned daemon MUST serve the same store as the session that
    // spawned it. Normally the launcher's export rides process.env — but any
    // spawn context that lost it (direct `node dist/mercury.mjs`, a scrubbed
    // env) silently split state across homes: the live-E2E's first run had
    // the daemon healing an EMPTY foreign-home teams dir while the session's
    // mail sat in the session's own home. Stamp the RESOLVED home explicitly;
    // an explicit extraEnv override below still wins.
    env.MERCURY_CONFIG_DIR = getMercuryHome()
    // do NOT pin the SPAWNER's session OAuth token (+ subscription/tier +
    // any token file-descriptor) into the detached daemon — scrub it so the daemon
    // re-resolves ITS OWN account token from config (keychain), preventing
    // cross-account misattribution on a shared config home. Only scrub when a
    // stored token exists (env-only auth has no fallback, so keep the env token).
    // The strip set is STORED_TOKEN_SCRUB_VARS — one home, shared with the
    // restart successor's door (daemon/main.ts).
    const storedTokenAtSpawn = hasStoredOAuthToken()
    if (storedTokenAtSpawn) {
      for (const k of STORED_TOKEN_SCRUB_VARS) {
        delete env[k]
      }
    }
    // The env-kept residual's RECORD (HB-0078's remainder): a spawn whose
    // gate KEPT an env bearer (no stored token existed, so the daemon runs
    // on the spawner's env credential) is remembered — the FIRST sign-in
    // that lands afterwards asks this daemon to restart when idle, and the
    // successor's gated scrub re-resolves the operator's stored account.
    envKeptAuthAtSpawn =
      !storedTokenAtSpawn && STORED_TOKEN_SCRUB_VARS.some(k => (env[k] ?? '').trim() !== '')
    for (const [k, v] of Object.entries(opts?.extraEnv ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    // Daemon log capture: stdio would otherwise be
    // 'ignore', which swallowed the daemon's own spawn lines AND every seat
    // child's stderr (they share the daemon's stderr) — including the seat
    // boot self-checks built precisely to make mis-wiring observable — a
    // failed run would otherwise leave ZERO recoverable evidence. Append to
    // <project>/.mercury/daemon/daemon.log instead; open failures degrade to
    // 'ignore' (a log must never block the engage).
    let outFd: number | 'ignore' = 'ignore'
    try {
      const logDir = adoptiveProjectPath(projectDir, 'daemon')
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, 'daemon.log')
      // Size-gated single rotation (RESOURCE: this is the ONLY open of
      // daemon.log in the tree, append-only, alive for the daemon's whole
      // multi-day life and shared as stderr by every seat child). >5MB at
      // engage ⇒ roll to daemon.log.1 (clobbering the prior roll): growth is
      // bounded ~2×cap while the previous engage's forensics survive.
      // Rotation failure degrades to plain append — a log must never block.
      try {
        if (statSync(logPath).size > 5 * 1024 * 1024) {
          // Bounded win32 retry: the previous engage's daemon (or
          // AV tailing the log) briefly holding it must not skip a rotation.
          renameWithWin32RetrySync(logPath, `${logPath}.1`)
        }
      } catch {
        /* absent or unrotatable — append as-is */
      }
      outFd = openSync(logPath, 'a')
    } catch {
      outFd = 'ignore'
    }
    // The explicit verb: the bare-dir positional still parses (daemon/verbs
    // keeps it for by-hand cron entries), but the product's own spawn says
    // what it means.
    const child = spawn(process.execPath, [script, 'daemon', 'run', projectDir], {
      // Run the daemon IN the project dir it schedules — deterministic for every
      // cwd-relative operation (a worker's worktree carve resolves under
      // findCanonicalGitRoot(getCwd()); without this a daemon inheriting a
      // different foreground cwd would work in the WRONG repo).
      cwd: projectDir,
      detached: true,
      // win32: a detached console child gets its OWN VISIBLE console window
      // by default — the field report's "keeps opening and closing
      // powershell". Hide it; no-op elsewhere.
      windowsHide: true,
      stdio: ['ignore', outFd, outFd],
      env,
    })
    if (typeof outFd === 'number') {
      // The parent's copy of the fd — the child holds its own dup.
      try {
        closeSync(outFd)
      } catch {
        /* already closed */
      }
    }
    // A spawn failure (bad cwd, missing exe) emits 'error' ASYNCHRONOUSLY — an
    // unhandled 'error' on a ChildProcess THROWS in the parent. Handle it so a
    // failed owned-daemon start DEGRADES (logged), never crashes the foreground
    // engage (P11: a nonexistent projectDir was crashing the caller).
    child.on('error', e => logForDebugging(`[${label}] spawnOwnedDaemon: child error (ignored): ${e}`))
    child.unref()
    logForDebugging(`[${label}] spawnOwnedDaemon: spawned detached daemon (pid ${child.pid}) for ${projectDir}`)
    ownedSpawnLabelThisProcess = label
    if (child.pid && !opts?.persist && shouldReapAutoStartedDaemon(flagEnv('MERCURY_SCRIBE_DAEMON_PERSIST'))) {
      reapDaemonOnSessionExit(child.pid)
    }
    return child.pid
  } catch (e) {
    logForDebugging(`[${label}] spawnOwnedDaemon: spawn failed: ${e}`)
    return undefined
  }
}
