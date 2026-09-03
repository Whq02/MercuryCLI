
import { execFile, spawnSync } from 'node:child_process'
import { procLiveToken } from '../utils/genericProcessUtils.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const OWNER_PID_ENV = 'MERCURY_DAEMON_OWNER_PID'

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
    const local = procLiveToken(pid)
    if (local !== undefined && local !== null) return local
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

export function parseOwnerPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[OWNER_PID_ENV] ?? env.MERCURY_DAEMON_OWNER_PID)?.trim()
  if (!raw) return null
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
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
