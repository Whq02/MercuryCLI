
import { execFile, spawnSync } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { existsSync, fstatSync, readFileSync } from 'node:fs'
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

const startInstantArgs = (pid: number): string[] => [
  '-NoProfile',
  '-Command',
  `$d = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate; if ($d) { $d.ToUniversalTime().ToString('o') }`,
]

type StartForm = 'token' | 'instant'

const START_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/

export function isProcessStartInstant(token: string | null | undefined): boolean {
  return typeof token === 'string' && START_INSTANT.test(token.trim())
}

function startFormLike(like: string | null | undefined): StartForm {
  return process.platform === 'win32' && isProcessStartInstant(like) ? 'instant' : 'token'
}

function startInstantForm(): StartForm {
  return process.platform === 'win32' ? 'instant' : 'token'
}

const win32StartArgs = (pid: number, form: StartForm): string[] => (form === 'instant' ? startInstantArgs(pid) : startTokenArgs(pid))

function win32StartTokenVerdict(probe: {
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

const LINUX_CLOCK_TICKS_PER_SECOND = 100
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
let linuxBootSeconds: number | null = null

function linuxBootTime(): number | null {
  if (linuxBootSeconds !== null) return linuxBootSeconds
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n').find(row => row.startsWith('btime '))
    const seconds = line === undefined ? Number.NaN : Number(line.slice(6).trim())
    if (!Number.isFinite(seconds)) return null
    linuxBootSeconds = seconds
    return seconds
  } catch {
    return null
  }
}

export function lstartWords(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${WEEKDAYS[at.getDay()]} ${MONTH_NAMES[at.getMonth()]} ${String(at.getDate()).padStart(2, ' ')} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} ${at.getFullYear()}`
}

export function linuxProcessStartToken(pid: number, read: (path: string) => string = path => readFileSync(path, 'utf8'), bootSeconds: number | null = linuxBootTime()): string | null {
  let stat: string
  try {
    stat = read(`/proc/${pid}/stat`)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ESRCH' ? '' : null
  }
  const closing = stat.lastIndexOf(')')
  if (closing < 0 || bootSeconds === null) return null
  const fields = stat.slice(closing + 1).trim().split(/\s+/)
  const startTicks = Number(fields[19])
  if (!Number.isFinite(startTicks)) return null
  return lstartWords(new Date((bootSeconds + Math.floor(startTicks / LINUX_CLOCK_TICKS_PER_SECOND)) * 1000))
}

export function getProcessStartToken(pid: number, like?: string | null): string | null {
  return startTokenOf(pid, startFormLike(like))
}

export function getProcessStartInstant(pid: number): string | null {
  return startTokenOf(pid, startInstantForm())
}

function startTokenOf(pid: number, form: StartForm): string | null {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(win32PsExe(), win32StartArgs(pid, form), {
        encoding: 'utf-8',
        timeout: 2000,
        windowsHide: true,
        env: { ...subprocessEnv() },
      })
      return invalidateDeadStartToken(pid, win32StartTokenVerdict({ ran: !r.error, exitCode: r.status, stdout: r.stdout, stderr: r.stderr }))
    }
    if (process.platform === 'linux') return invalidateDeadStartToken(pid, linuxProcessStartToken(pid))
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 2000,
      env: { ...subprocessEnv(), LC_ALL: 'C' },
    })
    if (r.error) return null
    if (r.status !== 0) return invalidateDeadStartToken(pid, '')
    const s = (r.stdout || '').trim()
    return invalidateDeadStartToken(pid, s)
  } catch {
    return null
  }
}

export function getProcessStartTokenAsync(pid: number, like?: string | null): Promise<string | null> {
  return startTokenOfAsync(pid, startFormLike(like))
}

export function getProcessStartInstantAsync(pid: number): Promise<string | null> {
  return startTokenOfAsync(pid, startInstantForm())
}

function startTokenOfAsync(pid: number, form: StartForm): Promise<string | null> {
  return new Promise<string | null>(resolve => {
    const unknownErr = (err: unknown): boolean => {
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      return e?.code === 'ENOENT' || e?.killed === true
    }
    try {
      if (process.platform === 'win32') {
        execFile(
          win32PsExe(),
          win32StartArgs(pid, form),
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
      if (process.platform === 'linux') {
        resolve(linuxProcessStartToken(pid))
        return
      }
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { windowsHide: true, encoding: 'utf-8', timeout: 3000, env: { ...subprocessEnv(), LC_ALL: 'C' } },
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
  }).then(token => invalidateDeadStartToken(pid, token))
}

const START_FORMS: readonly StartForm[] = ['token', 'instant']
const startTokenCache: Record<StartForm, Map<number, { token: string; at: number }>> = { token: new Map(), instant: new Map() }
const startTokenInflight: Record<StartForm, Map<number, Promise<string | null>>> = { token: new Map(), instant: new Map() }

function forgetStartTokens(pid: number): void {
  for (const form of START_FORMS) {
    startTokenCache[form].delete(pid)
    startTokenInflight[form].delete(pid)
  }
}

function invalidateDeadStartToken(pid: number, token: string | null): string | null {
  if (token === '') forgetStartTokens(pid)
  return token
}

const PROCESS_START_CACHE_MS = 3000
const PROCESS_START_PROBE_TIMEOUT_MS = 1500

type StartProbeResult = { kind: 'reply'; code: number; stdout: string; stderr: string } | { kind: 'failed' | 'timeout' }

function runStartProbe(file: string, args: string[], deadline: number): Promise<StartProbeResult> {
  const remaining = Math.ceil(deadline - performance.now())
  if (remaining <= 0) return Promise.resolve({ kind: 'timeout' })
  return new Promise(resolve => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const finish = (result: StartProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' })
      try { child?.kill('SIGKILL') } catch {}
    }, remaining)
    try {
      child = execFile(file, args, {
        encoding: 'utf-8', timeout: remaining, killSignal: 'SIGKILL', windowsHide: true,
        env: { ...subprocessEnv(), LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number')) {
          finish({ kind: error.killed ? 'timeout' : 'failed' })
          return
        }
        finish({ kind: 'reply', code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
      })
    } catch {
      finish({ kind: 'failed' })
    }
  })
}

function parseStartBatch(pids: readonly number[], reply: StartProbeResult, windows: boolean): Map<number, string | null> | null {
  if (reply.kind !== 'reply' || reply.stderr.trim() || (reply.code !== 0 && (windows || reply.code !== 1 || reply.stdout.trim()))) return null
  const tokens = new Map<number, string | null>(pids.map(pid => [pid, '']))
  try {
    const rows: unknown = windows ? JSON.parse(reply.stdout) : reply.stdout.split('\n').filter(line => line.trim()).map(line => {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
      return match ? { pid: Number(match[1]), token: match[2] } : null
    })
    if (!Array.isArray(rows)) return null
    const seen = new Set<number>()
    for (const row of rows) {
      if (!row || !tokens.has(row.pid) || seen.has(row.pid) || typeof row.token !== 'string' || !row.token.trim()) return null
      seen.add(row.pid)
      tokens.set(row.pid, row.token.trim())
    }
    return tokens
  } catch {
    return null
  }
}

const WIN32_BATCH_TOKEN: Record<StartForm, string> = {
  token: '($_.CreationDate | Out-String).Trim()',
  instant: "$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' })",
}

async function probeStartTokens(pids: readonly number[], form: StartForm): Promise<Map<number, string | null>> {
  if (process.platform === 'linux') return new Map(pids.map(pid => [pid, linuxProcessStartToken(pid)]))
  const deadline = performance.now() + PROCESS_START_PROBE_TIMEOUT_MS
  const windows = process.platform === 'win32'
  const file = windows ? win32PsExe() : 'ps'
  const args = windows ? [
    '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "${pids.map(pid => `ProcessId=${pid}`).join(' OR ')}" -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; token=${WIN32_BATCH_TOKEN[form]} } })`,
  ] : ['-o', 'pid=', '-o', 'lstart=', '-p', pids.join(',')]
  const reply = await runStartProbe(file, args, deadline)
  const batch = parseStartBatch(pids, reply, windows)
  if (batch) return batch
  if (reply.kind === 'timeout' || performance.now() >= deadline) return new Map(pids.map(pid => [pid, null]))
  const tokens = new Map<number, string | null>()
  for (const pid of pids) {
    const single = await runStartProbe(file, windows ? win32StartArgs(pid, form) : ['-o', 'lstart=', '-p', String(pid)], deadline)
    const token = single.kind !== 'reply' ? null : windows
      ? win32StartTokenVerdict({ ran: true, exitCode: single.code, stdout: single.stdout, stderr: single.stderr })
      : single.code === 0 ? single.stdout.trim() : single.code === 1 && !single.stderr.trim() ? '' : null
    tokens.set(pid, token)
  }
  return tokens
}

export async function getProcessStartTokensAsync(holders: readonly { pid: number; procStart?: string }[], maxAgeMs = PROCESS_START_CACHE_MS): Promise<Map<number, string | null>> {
  return startTokensOf(holders, maxAgeMs, null)
}

async function startTokensOf(holders: readonly { pid: number; procStart?: string }[], maxAgeMs: number, asked: StartForm | null): Promise<Map<number, string | null>> {
  const expected = new Map<number, Set<string>>()
  for (const holder of holders) {
    if (!Number.isSafeInteger(holder.pid) || holder.pid <= 1) continue
    const tokens = expected.get(holder.pid) ?? new Set<string>()
    if (holder.procStart) tokens.add(holder.procStart)
    expected.set(holder.pid, tokens)
  }
  const result = new Map<number, string | null>()
  const pending: Promise<void>[] = []
  const missing: Record<StartForm, number[]> = { token: [], instant: [] }
  const wait = (pid: number, probe: Promise<string | null>): void => { pending.push(probe.then(token => { result.set(pid, token) })) }
  for (const [pid, tokens] of expected) {
    if (!isProcessAlive(pid)) {
      forgetStartTokens(pid)
      result.set(pid, '')
      continue
    }
    const form = asked ?? ([...tokens].some(token => startFormLike(token) === 'instant') ? 'instant' : 'token')
    const hit = startTokenCache[form].get(pid)
    if (hit && Date.now() - hit.at < maxAgeMs && [...tokens].every(token => token === hit.token)) {
      result.set(pid, hit.token)
      continue
    }
    const inflight = startTokenInflight[form].get(pid)
    if (inflight) wait(pid, inflight)
    else missing[form].push(pid)
  }
  for (const form of START_FORMS) {
    if (missing[form].length === 0) continue
    const batch = probeStartTokens(missing[form], form)
    for (const pid of missing[form]) {
      const probe = batch.then(tokens => tokens.get(pid) ?? null, () => null).then(token => {
        if (startTokenInflight[form].get(pid) === probe) {
          startTokenInflight[form].delete(pid)
          if (token) startTokenCache[form].set(pid, { token, at: Date.now() })
          else startTokenCache[form].delete(pid)
        }
        return token
      })
      startTokenInflight[form].set(pid, probe)
      wait(pid, probe)
    }
  }
  await Promise.all(pending)
  return result
}

export function getProcessStartTokenCachedOrRefresh(pid: number, maxAgeMs = 10_000, like?: string | null): string | null {
  return startTokenCachedOrRefresh(pid, maxAgeMs, startFormLike(like))
}

export function getProcessStartInstantCachedOrRefresh(pid: number, maxAgeMs = 10_000): string | null {
  return startTokenCachedOrRefresh(pid, maxAgeMs, startInstantForm())
}

function startTokenCachedOrRefresh(pid: number, maxAgeMs: number, form: StartForm): string | null {
  if (!isProcessAlive(pid)) {
    forgetStartTokens(pid)
    return ''
  }
  const hit = startTokenCache[form].get(pid)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.token
  void startTokensOf([{ pid }], maxAgeMs, form)
  return hit ? hit.token : null
}

function ownerIdentityMatches(
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
  const raw = env[OWNER_PID_ENV]?.trim()
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


type OwnerGoneWhy = 'owner-gone' | 'owner-replaced' | 'owner-pipe-eof'

interface OwnerWatchPortsV1 {
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

interface OwnerWatchFactsV1 {
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

  let cameBack = false
  const probeDue = (t: number): boolean => {
    if (!identityCheckable || inflight || t < facts.backoffUntil) return false
    return facts.identityLost || cameBack
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
      if (facts.deadStreak > 0) cameBack = true
      if (probeDue(now())) {
        cameBack = false
        await probe()
      }
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
