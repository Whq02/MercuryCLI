import { spawnSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { execFileNoThrow, execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'


export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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


export type Win32ProcMeta = {
  found: boolean
  commandLine: string | null
  startToken: string | null
}

let cachedPowerShellExe: string | null = null

export function win32PowerShellExe(): string {
  if (cachedPowerShellExe) return cachedPowerShellExe
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(entry => entry.length > 0)
  for (const entry of pathEntries) {
    const candidate = join(entry, 'pwsh.exe')
    try {
      if (existsSync(candidate)) {
        cachedPowerShellExe = candidate
        return candidate
      }
    } catch {
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
  }
  cachedPowerShellExe = 'powershell.exe'
  return cachedPowerShellExe
}

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

export function getWin32ProcessMeta(pid: number, opts?: { maxAgeMs?: number }): Win32ProcMeta | null {
  const cached = cachedMeta(pid, opts?.maxAgeMs ?? DEFAULT_META_MAX_AGE_MS)
  if (cached) return cached
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
