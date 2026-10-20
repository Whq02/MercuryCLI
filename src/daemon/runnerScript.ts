import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { subprocessEnv } from '../utils/subprocessEnv.js'

const READ_WAIT_MS = 4_000

function commandLineOf(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  return new Promise(done => {
    const file = platform === 'win32' ? powerShellPath() : 'ps'
    const args = platform === 'win32'
      ? ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]
      : ['-ww', '-o', 'args=', '-p', String(pid)]
    execFile(file, args, { env: { ...subprocessEnv(), LC_ALL: 'C' }, timeout: READ_WAIT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== 'string' || stdout.trim() === '') return done(null)
      done(stdout.trim())
    })
  })
}

let powerShellCached: string | null = null

function powerShellPath(): string {
  if (powerShellCached !== null) return powerShellCached
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
  powerShellCached = fromPath ?? (existsSync(fixed) ? fixed : 'powershell.exe')
  return powerShellCached
}

export function bundleArgumentOf(commandLine: string): string | null {
  const quoted = /"([^"]*mercury\.mjs)"/.exec(commandLine)
  if (quoted !== null) return quoted[1]!
  const part = commandLine.split(/\s+/).find(piece => piece.endsWith('mercury.mjs'))
  return part ?? null
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function sameScript(a: string | null, b: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (a === null || b === null || a === '' || b === '') return false
  const fold = (p: string): string => (platform === 'win32' ? realOrResolved(p).toLowerCase() : realOrResolved(p))
  return fold(a) === fold(b)
}

export async function runnerScriptOf(pid: number | undefined, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return null
  const line = await commandLineOf(pid, platform)
  if (line === null) return null
  return bundleArgumentOf(line)
}
