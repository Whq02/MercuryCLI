import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { execFileNoThrow, execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'

/**
 * Cross-platform process liveness, ancestry, command lines and start tokens.
 */

/**
 * A pid of 1 or less is never running (0 addresses the process group, 1 is
 * init). A permission error means the process exists but belongs to another
 * user — reported as NOT running, deliberately conservative for lock
 * recovery: a live lock is never stolen.
 */
export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A restart-stable identity for whoever currently owns a pid (Linux only:
 * the kernel stat file's start-time field, the 22nd overall, in clock
 * ticks). The command field can contain spaces and parentheses, so the
 * parse anchors on the LAST closing parenthesis; the tail then begins at
 * the state field, so the start time is index 19 of the split tail.
 *
 * A "nothing" answer says nothing about liveness — only that reuse cannot be
 * proved here, so the caller must assume the recorded process still owns
 * the pid. Reading it as a death verdict is the failure mode to avoid.
 */
export function procStartToken(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closeParen = stat.lastIndexOf(')')
    if (closeParen === -1) return undefined
    const tail = stat.slice(closeParen + 2).split(' ')
    const token = tail[19]
    return token && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

export function currentProcStart(): string | undefined {
  return procStartToken(process.pid)
}

const ANCESTOR_TIMEOUT_MS = 3000

/**
 * Parents only, nearest to furthest, in a single subprocess invocation — the
 * starting pid is never in the result. At most maxDepth iterations. The
 * POSIX walk stops at a missing, zero or init parent; the Windows walk
 * stops only at a missing or zero parent. Empty on any failure. Both walks
 * invoke the stock Windows PowerShell by name; they deliberately do not go
 * through the pwsh-preferred resolver used by the metadata core (the two
 * paths were tuned separately).
 */
export async function getAncestorPidsAsync(pid: number, maxDepth: number = 10): Promise<number[]> {
  let result
  if (process.platform === 'win32') {
    const script = `$p=${pid};$out=@();for($i=0;$i -lt ${maxDepth};$i++){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','`
    result = await execFileNoThrow('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: ANCESTOR_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
  } else {
    const script = `p=${pid}; i=0; while [ $i -lt ${maxDepth} ]; do pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); if [ -z "$pp" ] || [ "$pp" = "0" ] || [ "$pp" = "1" ]; then break; fi; echo "$pp"; p=$pp; i=$((i+1)); done`
    result = await execFileNoThrow('sh', ['-c', script], {
      timeout: ANCESTOR_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
  }
  if (result.code !== 0 || result.stdout.trim() === '') return []
  return result.stdout
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => Number(entry))
    .filter(entry => Number.isInteger(entry))
}

/**
 * The same walk collecting command lines, NUL-separated (commands can
 * contain newlines). Unlike the pid walk this INCLUDES the starting
 * process's own command line as the first entry; an empty command line
 * contributes no entry.
 */
export async function getAncestorCommandsAsync(pid: number, maxDepth: number = 10): Promise<string[]> {
  let result
  if (process.platform === 'win32') {
    const script = `$p=${pid};$out=@();for($i=0;$i -lt ${maxDepth};$i++){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;if(-not $proc){break};if($proc.CommandLine){$out+=$proc.CommandLine};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0 -or $pp -eq 1){break};$p=$pp};$out -join [char]0`
    result = await execFileNoThrow('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: ANCESTOR_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
  } else {
    const script = `p=${pid}; i=0; while [ $i -lt ${maxDepth} ]; do cmd=$(ps -o command= -p "$p" 2>/dev/null); if [ -n "$cmd" ]; then printf '%s\\0' "$cmd"; fi; pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); if [ -z "$pp" ] || [ "$pp" = "0" ] || [ "$pp" = "1" ]; then break; fi; p=$pp; i=$((i+1)); done`
    result = await execFileNoThrow('sh', ['-c', script], {
      timeout: ANCESTOR_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
  }
  if (result.code !== 0 || result.stdout === '') return []
  return result.stdout.split('\0').filter(entry => entry.length > 0)
}

// ---------------------------------------------------------------------------
// Windows process metadata: one query returns both the command line and the
// start token, cached per pid.
// ---------------------------------------------------------------------------

export type Win32ProcMeta = {
  found: boolean
  commandLine: string | null
  startToken: string | null
}

let cachedPowerShellExe: string | null = null

/**
 * Prefer pwsh.exe found by a zero-spawn PATH scan, then the fixed Program
 * Files location for PowerShell 7, else powershell.exe. The modern shell
 * starts roughly twice as fast. Chosen once and cached.
 */
export function win32PowerShellExe(): string {
  if (cachedPowerShellExe) return cachedPowerShellExe
  // The platform's path-list delimiter, not a hard-coded semicolon.
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(entry => entry.length > 0)
  for (const entry of pathEntries) {
    const candidate = join(entry, 'pwsh.exe')
    try {
      if (existsSync(candidate)) {
        cachedPowerShellExe = candidate
        return candidate
      }
    } catch {
      // Keep scanning.
    }
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const fixed = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  try {
    if (existsSync(fixed)) {
      cachedPowerShellExe = fixed
      return fixed
    }
  } catch {
    // Fall through.
  }
  cachedPowerShellExe = 'powershell.exe'
  return cachedPowerShellExe
}

// Script output contract: a found pid emits `<command line>` NUL `<creation
// date>`; a gone pid emits empty output. NUL is the separator because a
// command line can contain anything else.
function metaScript(pid: number): string {
  return `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue;if($p){[Console]::Out.Write(($p.CommandLine)+[char]0+($p.CreationDate))}`
}

function parseMetaOutput(output: string): Win32ProcMeta {
  const separator = output.indexOf('\0')
  if (separator === -1) return { found: false, commandLine: null, startToken: null }
  const command = output.slice(0, separator).trim()
  const token = output.slice(separator + 1).trim()
  return {
    found: true,
    commandLine: command === '' ? null : command,
    startToken: token === '' ? null : token,
  }
}

const DEFAULT_META_MAX_AGE_MS = 10_000
// Only FOUND results are cached: a found answer for a live pid does not
// change, and the age bound exists for callers doing reuse detection.
const metaCache = new Map<number, { at: number; meta: Win32ProcMeta }>()
const inFlightMeta = new Map<number, Promise<Win32ProcMeta | null>>()

function cachedMeta(pid: number, maxAgeMs: number): Win32ProcMeta | null {
  const entry = metaCache.get(pid)
  if (entry && Date.now() - entry.at <= maxAgeMs) return entry.meta
  return null
}

function rememberMeta(pid: number, meta: Win32ProcMeta): void {
  if (meta.found) metaCache.set(pid, { at: Date.now(), meta })
}

/**
 * Synchronous accessor (2 s timeout, hidden window). A spawn ERROR object
 * is failure (null — unknown, never a death verdict); a non-zero exit with
 * output is still parsed.
 */
export function getWin32ProcessMeta(pid: number, opts?: { maxAgeMs?: number }): Win32ProcMeta | null {
  const cached = cachedMeta(pid, opts?.maxAgeMs ?? DEFAULT_META_MAX_AGE_MS)
  if (cached) return cached
  // A direct argv spawn (executable plus argument array, hidden window,
  // 2 s timeout) — never a hand-quoted shell command string.
  const result = spawnSync(
    win32PowerShellExe(),
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', metaScript(pid)],
    { timeout: 2000, windowsHide: true, encoding: 'utf8', env: { ...subprocessEnv() } },
  )
  if (result.error) return null
  const meta = parseMetaOutput(result.stdout ?? '')
  rememberMeta(pid, meta)
  return meta
}

/**
 * Asynchronous, render-path-safe accessor (3 s timeout), single-flight per
 * pid: concurrent callers share one in-flight promise, always cleared. A
 * non-zero exit WITH empty output is failure (null).
 */
export function getWin32ProcessMetaAsync(pid: number, opts?: { maxAgeMs?: number }): Promise<Win32ProcMeta | null> {
  const cached = cachedMeta(pid, opts?.maxAgeMs ?? DEFAULT_META_MAX_AGE_MS)
  if (cached) return Promise.resolve(cached)
  const existing = inFlightMeta.get(pid)
  if (existing) return existing
  const pending = (async (): Promise<Win32ProcMeta | null> => {
    try {
      const result = await execFileNoThrow(
        win32PowerShellExe(),
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', metaScript(pid)],
        { timeout: 3000 },
      )
      if (result.code !== 0 && result.stdout === '') return null
      const meta = parseMetaOutput(result.stdout)
      rememberMeta(pid, meta)
      return meta
    } finally {
      inFlightMeta.delete(pid)
    }
  })()
  inFlightMeta.set(pid, pending)
  return pending
}

/**
 * @deprecated Prefer the ancestor form. On Windows validates the pid and
 * routes through the shared cached core (also warming the start token);
 * elsewhere a single-process command query with a 1 s timeout.
 */
export function getProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      if (!Number.isInteger(pid) || pid <= 0) return null
      return getWin32ProcessMeta(pid)?.commandLine ?? null
    }
    const output = execSyncWithDefaults_DEPRECATED(`ps -o command= -p ${pid}`, { timeout: 1000 })
    return output ? output.trim() : null
  } catch {
    return null
  }
}
