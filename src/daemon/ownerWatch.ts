
import { execFile, spawnSync } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { existsSync, fstatSync } from 'node:fs'
import { Socket } from 'node:net'
import { delimiter, join } from 'node:path'

export const OWNER_PID_ENV = 'MERCURY_DAEMON_OWNER_PID'

export const OWNER_FD_ENV = 'MERCURY_DAEMON_OWNER_FD'

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

export function getProcessStartToken(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(win32PsExe(), startTokenArgs(pid), {
        encoding: 'utf-8',
        timeout: 2000,
        windowsHide: true,
        env: { ...subprocessEnv() },
      })
      return win32StartTokenVerdict({ ran: !r.error, exitCode: r.status, stdout: r.stdout, stderr: r.stderr })
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 2000,
      env: { ...subprocessEnv() },
    })
    if (r.error) return null
    if (r.status !== 0) return ''
    const s = (r.stdout || '').trim()
    return s.length > 0 ? s : ''
  } catch {
    return null
  }
}

export function getProcessStartTokenAsync(pid: number): Promise<string | null> {
  return new Promise(resolve => {
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
            const exitCode = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
            resolve(win32StartTokenVerdict({ ran: true, exitCode, stdout, stderr }))
          },
        )
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
            resolve('')
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

const startTokenCache = new Map<number, { token: string | null; at: number }>()
const startTokenInflight = new Set<number>()

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

export function ownerIdentityMatches(
  currentToken: string | null,
  baselineToken: string | null,
): boolean {
  if (baselineToken === null || baselineToken === '') return true
  if (currentToken === null) return true
  return currentToken === baselineToken
}

export const OWNER_WATCH_INTERVAL_MS = 4000
export const OWNER_WATCH_GRACE_CHECKS = 2
export const OWNER_IDENTITY_FLOOR_MS = 60_000
export const OWNER_PROBE_BACKOFF_FACTOR = 4

export function parseOwnerPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[OWNER_PID_ENV] ?? env.MERCURY_DAEMON_OWNER_PID)?.trim()
  if (!raw) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function parseOwnerFd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[OWNER_FD_ENV]?.trim()
  if (!raw) return null
  const fd = Number(raw)
  return Number.isInteger(fd) && fd > 2 ? fd : null
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

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


export interface OwnerPipeHandleV1 {
  armed: boolean
  why?: string
  close(): void
}

export function armOwnerPipe(fd: number, onClosed: () => void, log: (line: string) => void): OwnerPipeHandleV1 {
  const unarmed = (why: string): OwnerPipeHandleV1 => ({ armed: false, why, close: () => {} })
  try {
    const st = fstatSync(fd)
    if (!st.isSocket() && !st.isFIFO()) return unarmed(`fd ${fd} is not a pipe`)
  } catch (e) {
    return unarmed(`fd ${fd} is not open (${(e as NodeJS.ErrnoException).code ?? String(e)})`)
  }
  let sock: Socket
  try {
    sock = new Socket({ fd, readable: true, writable: false })
  } catch (e) {
    return unarmed(`fd ${fd} could not be wrapped (${String(e)})`)
  }
  let settled = false
  const gone = (): void => {
    if (settled) return
    settled = true
    onClosed()
  }
  sock.on('data', () => {
  })
  sock.on('end', gone)
  sock.on('close', gone)
  sock.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'EOF') {
      gone()
      return
    }
    if (settled) return
    settled = true
    log(`[daemon] owner pipe errored (${e.code ?? String(e)}) — the liveness beat and the identity probe watch alone`)
  })
  sock.resume()
  sock.unref()
  return {
    armed: true,
    close: () => {
      settled = true
      sock.destroy()
    },
  }
}


export type OwnerGoneWhy = 'owner-gone' | 'owner-replaced' | 'owner-pipe-eof'

export interface OwnerWatchPortsV1 {
  ownerPid: number
  baselineToken: string | null
  onOrphan: (why: OwnerGoneWhy) => void
  log: (line: string) => void
  alive?: (pid: number) => boolean
  probeToken?: (pid: number) => Promise<string | null>
  now?: () => number
  intervalMs?: number
  identityFloorMs?: number
  graceChecks?: number
  schedule?: boolean
}

export interface OwnerWatchFactsV1 {
  deadStreak: number
  probes: number
  probeFailures: number
  backoffUntil: number
  lastProbeAt: number
  identityLost: boolean
  pipeClosed: boolean
  reaped: OwnerGoneWhy | null
}

export interface OwnerWatchHandleV1 {
  beat(): Promise<void>
  ownerPipeClosed(): void
  stop(): void
  facts(): OwnerWatchFactsV1
}

export function startOwnerWatch(ports: OwnerWatchPortsV1): OwnerWatchHandleV1 {
  const alive = ports.alive ?? isProcessAlive
  const probeToken = ports.probeToken ?? getProcessStartTokenAsync
  const now = ports.now ?? Date.now
  const intervalMs = ports.intervalMs ?? OWNER_WATCH_INTERVAL_MS
  const floorMs = ports.identityFloorMs ?? OWNER_IDENTITY_FLOOR_MS
  const graceChecks = ports.graceChecks ?? OWNER_WATCH_GRACE_CHECKS
  const identityCheckable = ports.baselineToken !== null && ports.baselineToken !== ''
  const facts: OwnerWatchFactsV1 = {
    deadStreak: 0,
    probes: 0,
    probeFailures: 0,
    backoffUntil: 0,
    lastProbeAt: now(),
    identityLost: false,
    pipeClosed: false,
    reaped: null,
  }
  let inflight = false
  let stopped = false
  let failureLogged = false
  let timer: ReturnType<typeof setInterval> | undefined

  const probeDue = (t: number): boolean => {
    if (!identityCheckable || inflight || t < facts.backoffUntil) return false
    return facts.identityLost || t - facts.lastProbeAt >= floorMs
  }
  const probe = async (): Promise<void> => {
    inflight = true
    facts.probes++
    try {
      const token = await probeToken(ports.ownerPid)
      const t = now()
      facts.lastProbeAt = t
      if (token === null) {
        facts.probeFailures++
        facts.backoffUntil = t + floorMs * OWNER_PROBE_BACKOFF_FACTOR
        facts.identityLost = false
        if (!failureLogged) {
          failureLogged = true
          ports.log(
            `[daemon] owner identity probe could not run for pid ${ports.ownerPid} — next try in ${Math.round((floorMs * OWNER_PROBE_BACKOFF_FACTOR) / 1000)}s; the liveness beat keeps watching`,
          )
        }
        return
      }
      if (failureLogged) {
        failureLogged = false
        ports.log(`[daemon] owner identity probe answers again for pid ${ports.ownerPid}`)
      }
      facts.probeFailures = 0
      facts.backoffUntil = 0
      facts.identityLost = !ownerIdentityMatches(token, ports.baselineToken)
    } finally {
      inflight = false
    }
  }
  const stop = (): void => {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  const beat = async (): Promise<void> => {
    if (stopped) return
    let ownerAlive: boolean
    let why: OwnerGoneWhy = 'owner-gone'
    if (facts.pipeClosed) {
      ownerAlive = false
      why = 'owner-pipe-eof'
    } else if (!alive(ports.ownerPid)) {
      ownerAlive = false
    } else {
      if (probeDue(now())) await probe()
      ownerAlive = !facts.identityLost
      if (!ownerAlive) why = 'owner-replaced'
    }
    if (stopped) return
    facts.deadStreak = ownerAlive ? 0 : facts.deadStreak + 1
    if (
      decideOrphanShutdown({
        ownerPid: ports.ownerPid,
        ownerAlive,
        deadStreak: facts.deadStreak,
        graceChecks,
        persist: false,
      })
    ) {
      stop()
      facts.reaped = why
      ports.onOrphan(why)
    }
  }
  if (ports.schedule !== false) {
    timer = setInterval(() => {
      void beat()
    }, intervalMs)
    timer.unref?.()
  }
  return {
    beat,
    ownerPipeClosed: () => {
      if (stopped || facts.pipeClosed) return
      facts.pipeClosed = true
      void beat()
    },
    stop,
    facts: () => ({ ...facts }),
  }
}
