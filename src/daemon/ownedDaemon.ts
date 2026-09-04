import { daemonDir } from './controlSocket.js'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithWin32RetrySync } from '../substrate/durablePublish.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { hasStoredOAuthToken } from '../utils/auth.js'
import { subscribeSignInEpoch } from '../utils/accounts/signInLedger.js'
import { STORED_TOKEN_SCRUB_VARS } from '../utils/subprocessEnv.js'
import { OWNER_PID_ENV } from './ownerWatch.js'
import { flagEnv, flagPair } from '../substrate/flagRegistry.js'

export function shouldReapAutoStartedDaemon(persistEnv: string | undefined): boolean {
  return persistEnv !== '1'
}

export const OWNED_SPAWN_COOLDOWN_MS = 30_000
export const OWNED_SPAWN_SESSION_CAP = 5

export interface OwnedSpawnHistory {
  lastAt: number
  count: number
}

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

export function resetOwnedDaemonBreakerForTesting(): void {
  spawnHistory.clear()
}

export function decideDaemonReap(facts: {
  platform: NodeJS.Platform
  gracefulAsked: boolean
  stillAlive: boolean
}): 'already-down' | 'signal' | 'hard-kill' {
  if (!facts.stillAlive) return 'already-down'
  return facts.platform === 'win32' ? 'hard-kill' : 'signal'
}

function daemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return 'settled'
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return alive(pid) ? 'unsettled' : 'settled'
}

export const DAEMON_GRACEFUL_WAIT_MS = 1_500

const reapedPids = new Set<number>()
function reapDaemonOnSessionExit(pid: number): void {
  if (reapedPids.has(pid)) return
  reapedPids.add(pid)
  let gracefulAsked = false
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
      process.kill(pid, 'SIGTERM')
    } catch {
    }
  }
  process.once('exit', reap)
  process.once('SIGHUP', reap)
}

export function adoptOwnedDaemonPid(pid: number): void {
  if (!shouldReapAutoStartedDaemon(flagEnv('MERCURY_DAEMON_PERSIST'))) return
  reapDaemonOnSessionExit(pid)
}

let ownedSpawnLabelThisProcess: string | null = null

export function ownedDaemonLabelThisProcess(): string | null {
  return ownedSpawnLabelThisProcess
}

let envKeptAuthAtSpawn = false
let freshSigninRestartAsked = false

export function __resetOwnedDaemonFreshSigninForTest(opts?: {
  envKeptAuthAtSpawn?: boolean
  spawnLabel?: string | null
}): void {
  envKeptAuthAtSpawn = opts?.envKeptAuthAtSpawn ?? false
  freshSigninRestartAsked = false
  if (opts?.spawnLabel !== undefined) ownedSpawnLabelThisProcess = opts.spawnLabel
}

export async function restartOwnedDaemonForFreshSignin(opts?: {
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
  ).catch(() => undefined)
  return 'asked'
}

export function pokeDaemonSignIns(opts?: {
  rpc?: (req: { op: 'signIns'; refresh: true }, o: { timeoutMs: number }) => Promise<unknown>
}): Promise<void> {
  const rpc =
    opts?.rpc ??
    (async (req, o) => {
      const { daemonControlRpc } = await import('./controlSocket.js')
      return daemonControlRpc(req as never, o)
    })
  return rpc({ op: 'signIns', refresh: true }, { timeoutMs: 3000 }).then(
    () => undefined,
    () => undefined,
  )
}

let signInPokeArmed = false

export function armDaemonSignInPoke(opts?: Parameters<typeof pokeDaemonSignIns>[0]): void {
  if (signInPokeArmed) return
  signInPokeArmed = true
  subscribeSignInEpoch(() => {
    void pokeDaemonSignIns(opts)
  })
}

export function __resetDaemonSignInPokeForTest(): void {
  signInPokeArmed = false
}

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
  const now = Date.now()
  const history = spawnHistory.get(label)
  const verdict = decideOwnedSpawn(history, now)
  if (verdict !== 'spawn') {
    logForDebugging(
      verdict === 'capped'
        ? `[${label}] spawnOwnedDaemon: session cap ${OWNED_SPAWN_SESSION_CAP} reached — the daemon keeps dying at boot; read ${join(daemonDir(), 'daemon.log')}`
        : `[${label}] spawnOwnedDaemon: cooling down (${Math.round((now - (history?.lastAt ?? 0)) / 1000)}s since the last spawn) — skipped`,
    )
    return undefined
  }
  spawnHistory.set(label, { lastAt: now, count: (history?.count ?? 0) + 1 })
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...flagPair(OWNER_PID_ENV, String(process.pid)) }
    env.MERCURY_CONFIG_DIR = getMercuryHome()
    const storedTokenAtSpawn = hasStoredOAuthToken()
    if (storedTokenAtSpawn) {
      for (const k of STORED_TOKEN_SCRUB_VARS) {
        delete env[k]
      }
    }
    envKeptAuthAtSpawn =
      !storedTokenAtSpawn && STORED_TOKEN_SCRUB_VARS.some(k => (env[k] ?? '').trim() !== '')
    for (const [k, v] of Object.entries(opts?.extraEnv ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    let outFd: number | 'ignore' = 'ignore'
    try {
      const logDir = daemonDir()
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, 'daemon.log')
      try {
        if (statSync(logPath).size > 5 * 1024 * 1024) {
          renameWithWin32RetrySync(logPath, `${logPath}.1`)
        }
      } catch {
      }
      outFd = openSync(logPath, 'a')
    } catch {
      outFd = 'ignore'
    }
    const child = spawn(process.execPath, [script, 'daemon', 'run', projectDir], {
      cwd: projectDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, outFd],
      env,
    })
    if (typeof outFd === 'number') {
      try {
        closeSync(outFd)
      } catch {
      }
    }
    child.on('error', e => logForDebugging(`[${label}] spawnOwnedDaemon: child error (ignored): ${e}`))
    child.unref()
    logForDebugging(`[${label}] spawnOwnedDaemon: spawned detached daemon (pid ${child.pid}) for ${projectDir}`)
    ownedSpawnLabelThisProcess = label
    if (child.pid && !opts?.persist && shouldReapAutoStartedDaemon(flagEnv('MERCURY_DAEMON_PERSIST'))) {
      reapDaemonOnSessionExit(child.pid)
    }
    return child.pid
  } catch (e) {
    logForDebugging(`[${label}] spawnOwnedDaemon: spawn failed: ${e}`)
    return undefined
  }
}
