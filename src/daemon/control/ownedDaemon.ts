import { daemonDir } from './controlSocket.js'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithWin32RetrySync } from '../../platform/substrate/durablePublish.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { pidAlive } from '../../platform/processes/pidAlive.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { canonicalHomeSpelling, getMercuryHome } from '../../platform/environment/envUtils.js'
import { hasStoredOAuthToken } from '../../models/sign-in/credentials/auth.js'
import { subscribeSignInEpoch } from '../../models/sign-in/account-ledger/signInLedger.js'
import { STORED_TOKEN_SCRUB_VARS } from '../../platform/processes/subprocessEnv.js'
import { isProcessAlive, OWNER_FD_ENV, OWNER_PID_ENV } from './ownerWatch.js'
import { stampedTerminalPid, terminalStampsOf } from '../concourse-workers/record.js'
import { flagEnv, flagPair, flagSpellings, stampFlagOnEnv } from '../../platform/substrate/flagRegistry.js'
import { stampSpawnReceipt } from '../../platform/substrate/envStamps.js'
import type { Socket } from 'node:net'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { supportsGracefulSigterm } from '../../platform/host-os/processes.js'

const OWNER_PIPE_STDIO_INDEX = 3
const ownerPipeEnds = new Set<Socket>()

function shouldReapAutoStartedDaemon(persistEnv: string | undefined): boolean {
  return persistEnv !== '1'
}

const OWNED_SPAWN_COOLDOWN_MS = 30_000
const OWNED_SPAWN_SESSION_CAP = 5

interface OwnedSpawnHistory {
  lastAt: number
  count: number
}

function decideOwnedSpawn(
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
}): 'already-down' | 'signal' | 'hard-kill' | 'asked' {
  if (!facts.stillAlive) return 'already-down'
  if (supportsGracefulSigterm(facts.platform)) return 'signal'
  return facts.gracefulAsked ? 'asked' : 'hard-kill'
}

export async function shutdownOwnedDaemonGracefully(
  pid: number,
  opts?: {
    rpc?: (req: { op: 'shutdown'; reapWorkers: boolean }, o: { timeoutMs: number }) => Promise<unknown>
    alive?: (pid: number) => boolean
    waitMs?: number
  },
): Promise<'settled' | 'unsettled' | 'asked'> {
  const alive = opts?.alive ?? pidAlive
  const waitMs = opts?.waitMs ?? DAEMON_GRACEFUL_WAIT_MS
  const rpc =
    opts?.rpc ??
    (async (req, o) => {
      const { daemonControlRpc } = await import('./controlSocket.js')
      return daemonControlRpc(req, o)
    })
  try {
    const reply = (await rpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: Math.min(waitMs, 2000) })) as { ok?: unknown; op?: unknown } | null | undefined
    if (reply?.ok === true && reply.op === 'shutdown') return 'asked'
  } catch (error) {
    passedOver(error)
  }
  return alive(pid) ? 'unsettled' : 'settled'
}

const DAEMON_GRACEFUL_WAIT_MS = 1_500

export function anotherLiveCockpitHoldsDaemon(
  exceptPid: number,
  workersPath: string = join(daemonDir(), 'concourse-workers.json'),
): boolean {
  let parsed: { workers?: Record<string, { endedAt?: number; parkedAt?: number; focusedBy?: string; attachedBy?: string; focusedAlso?: Array<{ by: string }> }> }
  try {
    parsed = JSON.parse(readFileSync(workersPath, 'utf8'))
  } catch (err) {
    if (isENOENT(err)) return false
    logForDebugging(`[daemon] ${workersPath} could not be read (${err instanceof SyntaxError ? 'it is not valid JSON' : errorMessage(err)}), so the daemon is left running for any other window that may still use it`)
    return true
  }
  for (const rec of Object.values(parsed.workers ?? {})) {
    if (rec.endedAt !== undefined || rec.parkedAt !== undefined) continue
    for (const by of terminalStampsOf(rec)) {
      const pid = stampedTerminalPid(by)
      if (pid !== undefined && pid !== exceptPid && isProcessAlive(pid)) return true
    }
  }
  return false
}

const reapedPids = new Set<number>()
function reapDaemonOnSessionExit(pid: number): void {
  if (reapedPids.has(pid)) return
  reapedPids.add(pid)
  let gracefulAsked = false
  if (!supportsGracefulSigterm()) {
    let asking: Promise<void> | null = null
    let answered = false
    const askToShutDown = (): Promise<void> => {
      if (asking) return asking
      if (!pidAlive(pid)) return Promise.resolve()
      if (anotherLiveCockpitHoldsDaemon(process.pid)) return Promise.resolve()
      gracefulAsked = true
      asking = shutdownOwnedDaemonGracefully(pid).then(outcome => {
        logForDebugging(`[daemon] the owned daemon (pid ${pid}) was asked to shut down: ${outcome}`)
        answered = outcome === 'asked'
        if (outcome !== 'unsettled') return
        gracefulAsked = false
        reap()
      })
      return asking
    }
    registerCleanup(askToShutDown)
    process.once('SIGHUP', () => void askToShutDown())
    process.once('exit', () => {
      if (!answered) gracefulAsked = false
    })
  }
  const reap = (): void => {
    if (anotherLiveCockpitHoldsDaemon(process.pid)) return
    const verdict = decideDaemonReap({
      platform: process.platform,
      gracefulAsked,
      stillAlive: pidAlive(pid),
    })
    if (verdict === 'already-down' || verdict === 'asked') return
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      passedOver(error)
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
  try {
    const reply = (await rpc(
      {
        op: 'restart-when-idle',
        proto: MERCURY_DAEMON_PROTO,
        by: 'fresh sign-in after an env-kept spawn — the successor re-runs the credential scrub',
      },
      { timeoutMs: 3000 },
    )) as { ok?: unknown } | null | undefined
    if (reply?.ok === false) freshSigninRestartAsked = false
  } catch (error) {
    freshSigninRestartAsked = false
    logForDebugging(`[daemon] the restart after a fresh sign-in was not asked (the next sign-in asks again): ${errorMessage(error)}`)
  }
  return 'asked'
}

function pokeDaemonSignIns(opts?: {
  rpc?: (req: { op: 'signIns'; refresh: true }, o: { timeoutMs: number }) => Promise<unknown>
}): Promise<void> {
  const rpc =
    opts?.rpc ??
    (async (req, o) => {
      const { daemonControlRpc } = await import('./controlSocket.js')
      return daemonControlRpc(req, o)
    })
  return rpc({ op: 'signIns', refresh: true }, { timeoutMs: 3000 }).then(
    () => undefined,
    passedOverAs(undefined),
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


const hostEntry: string | undefined = (globalThis as { Bun?: { main?: string } }).Bun?.main ?? process.argv[1]

function isMercuryEntry(script: string): boolean {
  const normalized = script.replace(/\\/g, '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (/^mercury(?:\.m?js|\.cjs)?$/.test(name)) return true
  if (name === 'main.tsx' && /\/src\/main\.tsx$/.test(normalized)) return true
  return /\/src\/entrypoints\/[^/]+\.(?:m?[jt]sx?|cjs)$/.test(normalized)
}

export function spawnOwnedDaemon(
  projectDir: string,
  opts?: { label?: string; extraEnv?: Record<string, string | undefined>; persist?: boolean; script?: string; node?: string; ownerPipe?: boolean },
): number | undefined {
  const label = opts?.label ?? 'daemon'
  const script = opts?.script ?? process.argv[1]
  const node = opts?.node ?? process.execPath
  if (!script) {
    logForDebugging(`[${label}] spawnOwnedDaemon: no process.argv[1]; cannot spawn daemon`)
    return undefined
  }
  if (opts?.script === undefined && script === hostEntry && !isMercuryEntry(script)) {
    logForDebugging(`[${label}] spawnOwnedDaemon: ${script} is the running script and not a Mercury entry; the daemon is not spawned from it (the script would only relaunch itself)`)
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
    const env: NodeJS.ProcessEnv = { ...hostEnv(), ...flagPair(OWNER_PID_ENV, String(process.pid)) }
    const pinnedHome = flagEnv('MERCURY_CONFIG_DIR')
    const homeStamped = !pinnedHome || canonicalHomeSpelling(pinnedHome) !== getMercuryHome()
    stampFlagOnEnv(env, 'MERCURY_CONFIG_DIR', getMercuryHome())
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
      } catch (error) {
        passedOver(error)
      }
      outFd = openSync(logPath, 'a')
    } catch {
      outFd = 'ignore'
    }
    const ownerPipe = process.platform !== 'win32' && opts?.ownerPipe !== false
    if (ownerPipe) Object.assign(env, flagPair(OWNER_FD_ENV, String(OWNER_PIPE_STDIO_INDEX)))
    if (homeStamped) stampSpawnReceipt(env, ['MERCURY_CONFIG_DIR'])
    stampSpawnReceipt(env, [...flagSpellings(OWNER_PID_ENV), ...flagSpellings(OWNER_FD_ENV), ...Object.keys(opts?.extraEnv ?? {})])
    const child = spawn(node, [script, 'daemon', 'run', projectDir], {
      cwd: projectDir,
      detached: true,
      windowsHide: true,
      stdio: ownerPipe ? ['ignore', outFd, outFd, 'pipe'] : ['ignore', outFd, outFd],
      env,
    })
    const pipeEnd = ownerPipe ? (child.stdio[OWNER_PIPE_STDIO_INDEX] as Socket | null | undefined) : undefined
    if (pipeEnd) {
      pipeEnd.on('error', () => {
      })
      pipeEnd.unref()
      ownerPipeEnds.add(pipeEnd)
      pipeEnd.once('close', () => ownerPipeEnds.delete(pipeEnd))
    }
    if (typeof outFd === 'number') {
      try {
        closeSync(outFd)
      } catch (error) {
        passedOver(error)
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
