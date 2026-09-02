import { spawn, execFile } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { isInBundledMode } from './bundledMode.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'


export type RipgrepMode = 'system' | 'builtin' | 'embedded'

export type RipgrepConfig = {
  rgPath: string
  rgArgs: string[]
  argv0?: string
}

export function isRipgrepUsageDiagnostic(stderr: string): boolean {
  return /^error:|regex parse error|error parsing|unrecognized flag|invalid value/im.test(stderr)
}

export class RipgrepUsageError extends Error {
  readonly diagnostic: string

  constructor(diagnostic: string) {
    super(`ripgrep rejected the search: ${diagnostic}`)
    this.name = 'RipgrepUsageError'
    this.diagnostic = diagnostic
  }
}

export class RipgrepTimeoutError extends Error {
  readonly partialResults: string[]

  constructor(message: string, partialResults: string[]) {
    super(message)
    this.name = 'RipgrepTimeoutError'
    this.partialResults = partialResults
  }
}

const OUTPUT_CAP = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_S = 20
const WSL_TIMEOUT_S = 60
const KILL_ESCALATION_MS = 5000
const RG_NAME = 'rg'

function timeoutSeconds(): number {
  return getPlatform() === 'wsl' ? WSL_TIMEOUT_S : DEFAULT_TIMEOUT_S
}

function vendoredRgPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const platformDir = process.platform === 'win32' ? `${process.arch}-win32` : `${process.arch}-${process.platform}`
  return join(moduleDir, 'vendor', 'ripgrep', platformDir, process.platform === 'win32' ? 'rg.exe' : 'rg')
}

function devDependencyRg(): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const modules = join(moduleDir, '..', '..', 'node_modules', '@vscode')
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates = [
    join(modules, `ripgrep-${process.platform}-${process.arch}`, 'bin', exe),
    join(modules, 'ripgrep', 'bin', exe),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function systemRg(): string | null {
  const found = findExecutable(RG_NAME, [])
  return found.cmd !== RG_NAME ? RG_NAME : null
}

let resolvedConfig: { mode: RipgrepMode; config: RipgrepConfig } | null = null

export function resolveRipgrep(): { mode: RipgrepMode; config: RipgrepConfig } {
  if (resolvedConfig) return resolvedConfig
  let resolution: { mode: RipgrepMode; config: RipgrepConfig }
  if (isEnvDefinedFalsy(process.env.USE_BUILTIN_RIPGREP) && systemRg()) {
    resolution = { mode: 'system', config: { rgPath: RG_NAME, rgArgs: ['--no-config'] } }
  } else if (isInBundledMode()) {
    resolution = { mode: 'embedded', config: { rgPath: process.execPath, rgArgs: ['--no-config'], argv0: RG_NAME } }
  } else {
    const vendored = vendoredRgPath()
    const devRg = existsSync(vendored) ? null : devDependencyRg()
    if (existsSync(vendored)) {
      resolution = { mode: 'builtin', config: { rgPath: vendored, rgArgs: ['--no-config'] } }
    } else if (devRg !== null) {
      resolution = { mode: 'builtin', config: { rgPath: devRg, rgArgs: ['--no-config'] } }
    } else if (systemRg()) {
      resolution = { mode: 'system', config: { rgPath: RG_NAME, rgArgs: ['--no-config'] } }
    } else {
      resolution = { mode: 'builtin', config: { rgPath: vendored, rgArgs: ['--no-config'] } }
    }
  }
  resolvedConfig = resolution
  return resolution
}

export function ripgrepCommand(): RipgrepConfig {
  return resolveRipgrep().config
}

function unavailableRemedy(expectedPath: string): string {
  return (
    `The search binary was not found at ${expectedPath} and no system ripgrep is on PATH. ` +
    `Rebuild with the vendor step, or install ripgrep via your platform package manager.`
  )
}

export function searchToolsAvailability(): {
  available: boolean
  mode: RipgrepMode | 'none'
  path: string
  remedy?: string
} {
  const { mode, config } = resolveRipgrep()
  if (mode === 'embedded' || mode === 'system') return { available: true, mode, path: config.rgPath }
  if (existsSync(config.rgPath)) return { available: true, mode: 'builtin', path: config.rgPath }
  if (systemRg()) {
    resolvedConfig = null
    return { available: true, mode: 'system', path: RG_NAME }
  }
  return { available: false, mode: 'none', path: config.rgPath, remedy: unavailableRemedy(config.rgPath) }
}


let codesignChecked = false

async function maybeRepairCodesign(): Promise<void> {
  if (codesignChecked) return
  codesignChecked = true
  if (process.platform !== 'darwin') return
  const { mode, config } = resolveRipgrep()
  if (mode !== 'builtin') return
  const inspection = await execFileNoThrow('codesign', ['-dv', config.rgPath], { useCwd: false })
  const inspectionOutput = `${inspection.stdout}\n${inspection.stderr}`
  if (!inspectionOutput.split('\n').some(line => line.includes('linker-signed'))) return
  try {
    const sign = await execFileNoThrow(
      'codesign',
      ['--sign', '-', '--force', '--preserve-metadata=entitlements,requirements,flags,runtime', config.rgPath],
      { useCwd: false },
    )
    if (sign.code !== 0) logError(new Error(`codesign re-sign failed (${sign.code}): ${sign.stderr}`))
    const xattr = await execFileNoThrow('xattr', ['-d', 'com.apple.quarantine', config.rgPath], { useCwd: false })
    if (xattr.code !== 0 && xattr.stderr.trim() !== '') {
      logError(new Error(`quarantine removal failed (${xattr.code}): ${xattr.stderr}`))
    }
  } catch (err) {
    logError(err)
  }
}


type ProbeResult = { working: boolean; at: number; mode: RipgrepMode; path: string }

let probePromise: Promise<ProbeResult> | null = null

function probeHealth(): Promise<ProbeResult> {
  if (probePromise) return probePromise
  probePromise = (async (): Promise<ProbeResult> => {
    const { mode, config } = resolveRipgrep()
    try {
      let output: string
      let code: number | null
      if (config.argv0 !== undefined) {
        const child = Bun.spawn({
          cmd: [config.rgPath, ...config.rgArgs, '--version'],
          argv0: config.argv0,
          stdout: 'pipe',
          stderr: 'ignore',
        })
        output = await new Response(child.stdout as ReadableStream).text()
        code = await child.exited
      } else {
        const result = await execFileNoThrow(config.rgPath, [...config.rgArgs, '--version'], {
          timeout: 5000,
          useCwd: false,
        })
        output = result.stdout
        code = result.code
      }
      const working = code === 0 && output.length > 0 && output.startsWith('ripgrep ')
      logForDebugging(`ripgrep health: ${working ? 'working' : 'not working'} (mode ${mode}, path ${config.rgPath})`)
      return { working, at: Date.now(), mode, path: config.rgPath }
    } catch (err) {
      logForDebugging(`ripgrep health probe threw: ${String(err)}`)
      return { working: false, at: Date.now(), mode, path: config.rgPath }
    }
  })()
  return probePromise
}

let probeSettled: ProbeResult | null = null

export async function warmRipgrepStatus(): Promise<void> {
  probeSettled = await probeHealth()
}

export function getRipgrepStatus(): { mode: RipgrepMode | 'none'; path: string; working: boolean | null; present: boolean } {
  const { mode, config } = resolveRipgrep()
  const bare = !config.rgPath.includes('/') && !config.rgPath.includes('\\')
  const present = bare
    ? findExecutable(config.rgPath, []).cmd !== config.rgPath
    : existsSync(config.rgPath)
  return { mode, path: config.rgPath, working: probeSettled ? probeSettled.working : null, present }
}


type SpawnOutcome = {
  stdout: string
  stderr: string
  error: (Error & { code?: string | number }) | null
  signal: NodeJS.Signals | null
}

function spawnWithArgv0(
  config: RipgrepConfig,
  args: string[],
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise(resolvePromise => {
    const child = spawn(config.rgPath, args, {
      argv0: config.argv0,
      windowsHide: true,
      env: { ...subprocessEnv() },
      ...(abortSignal ? { signal: abortSignal } : {}),
    })
    let stdout = ''
    let stderr = ''
    let stdoutLatched = false
    let stderrLatched = false
    let settled = false
    let killedSignal: NodeJS.Signals | null = null

    const settle = (error: SpawnOutcome['error']): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      resolvePromise({ stdout, stderr, error, signal: killedSignal })
    }

    let escalationTimer: ReturnType<typeof setTimeout> | null = null
    const timeoutTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        killedSignal = 'SIGTERM'
        child.kill()
        return
      }
      killedSignal = 'SIGTERM'
      child.kill('SIGTERM')
      escalationTimer = setTimeout(() => {
        killedSignal = 'SIGKILL'
        child.kill('SIGKILL')
      }, KILL_ESCALATION_MS)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLatched) return
      stdout += chunk.toString('utf8')
      if (stdout.length > OUTPUT_CAP) {
        stdout = stdout.slice(0, OUTPUT_CAP)
        stdoutLatched = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLatched) return
      stderr += chunk.toString('utf8')
      if (stderr.length > OUTPUT_CAP) {
        stderr = stderr.slice(0, OUTPUT_CAP)
        stderrLatched = true
      }
    })
    child.on('error', err => {
      settle(err as SpawnOutcome['error'])
    })
    child.on('close', (code, signal) => {
      if (signal) killedSignal = signal
      if (code === 0 || code === 1) {
        settle(null)
        return
      }
      const error = new Error(`ripgrep exited with code ${code}${signal ? ` (signal ${signal})` : ''}`) as SpawnOutcome['error'] &
        Error
      ;(error as { code?: string | number }).code = code ?? undefined
      settle(error)
    })
  })
}

function spawnExecFile(
  config: RipgrepConfig,
  args: string[],
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise(resolvePromise => {
    execFile(
      config.rgPath,
      args,
      {
        maxBuffer: OUTPUT_CAP,
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...subprocessEnv() },
        killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
        ...(abortSignal ? { signal: abortSignal } : {}),
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: string | number; signal?: NodeJS.Signals; killed?: boolean }) | null
        if (err && typeof err.code === 'number' && (err.code === 0 || err.code === 1)) {
          resolvePromise({ stdout, stderr, error: null, signal: err.signal ?? null })
          return
        }
        resolvePromise({ stdout, stderr, error: err, signal: err?.signal ?? null })
      },
    )
  })
}

function runSpawn(config: RipgrepConfig, args: string[], abortSignal: AbortSignal | undefined, timeoutMs: number): Promise<SpawnOutcome> {
  return config.argv0 !== undefined ? spawnWithArgv0(config, args, abortSignal, timeoutMs) : spawnExecFile(config, args, abortSignal, timeoutMs)
}

function splitOutput(raw: string): string[] {
  return raw
    .trim()
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter(line => line !== '')
}


const EXHAUSTION_MARKERS = ['os error 11', 'Resource temporarily unavailable']

export interface RipgrepAnswer {
  lines: string[]
  complete: boolean
  reason?: string
}

export interface RipgrepOptions {
  timeoutMs?: number
}

export async function ripGrepAnswer(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  options: RipgrepOptions = {},
): Promise<RipgrepAnswer> {
  await maybeRepairCodesign()
  probeHealth().then(
    result => {
      probeSettled = result
    },
    err => logForDebugging(`ripgrep health probe rejected: ${String(err)}`),
  )
  const timeoutMs = options.timeoutMs ?? timeoutSeconds() * 1000
  const timeoutS = timeoutMs / 1000
  const runOnce = (singleThreaded: boolean): Promise<SpawnOutcome> => {
    const { config } = resolveRipgrep()
    const vector = [...config.rgArgs, ...(singleThreaded ? ['-j', '1'] : []), ...args, target]
    return runSpawn(config, vector, abortSignal, timeoutMs)
  }
  let outcome = await runOnce(false)
  if (outcome.error && EXHAUSTION_MARKERS.some(marker => outcome.stderr.includes(marker))) {
    outcome = await runOnce(true)
  }
  if (!outcome.error) return { lines: splitOutput(outcome.stdout), complete: true }

  const code = (outcome.error as { code?: string | number }).code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    if (code === 'ENOENT') {
      const { config } = resolveRipgrep()
      outcome.error.message = `${outcome.error.message}\n${unavailableRemedy(config.rgPath)}`
    }
    throw outcome.error
  }

  let salvaged = splitOutput(outcome.stdout)
  const signalTimedOut =
    abortSignal?.aborted === true &&
    (abortSignal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
  const isAbort = code === 'ABORT_ERR' && !signalTimedOut
  const isTimeout =
    outcome.signal === 'SIGTERM' || outcome.signal === 'SIGKILL' || (code === 'ABORT_ERR' && signalTimedOut)
  const isOverflow = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  const overflowReason = `the search output exceeded the ${OUTPUT_CAP / (1024 * 1024)}MB cap — results beyond it were dropped, so this answer is PARTIAL (${salvaged.length} line(s) kept); narrow the path or the pattern`
  if (isOverflow) {
    logError(new Error(overflowReason))
  }
  if ((isTimeout || isAbort || isOverflow) && salvaged.length > 0 && !outcome.stdout.endsWith('\n')) {
    salvaged = salvaged.slice(0, -1)
  }
  logForDebugging(
    `ripgrep failed: signal=${outcome.signal ?? 'none'} code=${String(code ?? 'none')} stderr=${outcome.stderr.slice(0, 500)} salvaged=${salvaged.length}`,
  )
  if (code !== 2 && code !== 'ABORT_ERR') logError(outcome.error)
  if (code === 2 && salvaged.length === 0 && isRipgrepUsageDiagnostic(outcome.stderr)) {
    throw new RipgrepUsageError(outcome.stderr.trim().split('\n').slice(0, 3).join(' '))
  }
  if (isAbort && salvaged.length === 0) {
    const abortError = new Error('The search was interrupted before it finished.')
    abortError.name = 'AbortError'
    throw abortError
  }
  if (isTimeout && salvaged.length === 0) {
    throw new RipgrepTimeoutError(
      `The search timed out after ${timeoutS} seconds. Files may have matched, but the walk did not finish — narrow the path or the pattern and try again.`,
      salvaged,
    )
  }
  const reason = isTimeout
    ? `the search timed out after ${timeoutS} seconds — the walk did not finish, so this answer is PARTIAL (${salvaged.length} line(s) kept); narrow the path or the pattern`
    : isAbort
      ? `the search was interrupted before it finished, so this answer is PARTIAL (${salvaged.length} line(s) kept)`
      : isOverflow
        ? overflowReason
        : `the search engine failed (exit ${String(code ?? 'unknown')}${outcome.signal ? `, signal ${outcome.signal}` : ''}): ${outcome.stderr.trim().split('\n').slice(0, 2).join(' ') || 'no diagnostic'} — this answer is INCOMPLETE`
  return { lines: salvaged, complete: false, reason }
}

export async function ripGrep(args: string[], target: string, abortSignal: AbortSignal): Promise<string[]> {
  const answer = await ripGrepAnswer(args, target, abortSignal)
  if (!answer.complete) throw new RipgrepTimeoutError(answer.reason ?? 'the search did not finish', answer.lines)
  return answer.lines
}


export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await maybeRepairCodesign()
  const { config } = resolveRipgrep()
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(config.rgPath, [...config.rgArgs, ...args, target], {
      ...(config.argv0 !== undefined ? { argv0: config.argv0 } : {}),
      windowsHide: true,
      signal: abortSignal,
      env: { ...subprocessEnv() },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let carried = ''
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) rejectPromise(err)
      else resolvePromise()
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      carried += chunk.toString('utf8')
      const lines: string[] = []
      for (;;) {
        const newline = carried.indexOf('\n')
        if (newline === -1) break
        let line = carried.slice(0, newline)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        lines.push(line)
        carried = carried.slice(newline + 1)
      }
      if (lines.length > 0) onLines(lines)
    })
    child.on('error', err => settle(err))
    child.on('close', code => {
      if (abortSignal.aborted) {
        settle()
        return
      }
      if (code === 0 || code === 1) {
        if (carried !== '') {
          const remainder = carried.endsWith('\r') ? carried.slice(0, -1) : carried
          onLines([remainder])
        }
        settle()
        return
      }
      settle(new Error(`ripgrep exited with code ${code}`))
    })
  })
}


export async function countFilesWithRg(args: string[], target: string, abortSignal: AbortSignal): Promise<number> {
  await maybeRepairCodesign()
  const { config } = resolveRipgrep()
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(config.rgPath, [...config.rgArgs, ...args, target], {
      ...(config.argv0 !== undefined ? { argv0: config.argv0 } : {}),
      windowsHide: true,
      signal: abortSignal,
      env: { ...subprocessEnv() },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let count = 0
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) rejectPromise(err)
      else resolvePromise(count)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] === 0x0a) count++
      }
    })
    child.on('error', err => settle(err))
    child.on('close', code => {
      if (code === 0 || code === 1) settle()
      else settle(new Error(`ripgrep exited with code ${code}`))
    })
  })
}

const roundedCountMemo = new Map<string, Promise<number | undefined>>()

export function countFilesRoundedRg(
  dirPath: string,
  abortSignal: AbortSignal,
  ignorePatterns: string[] = [],
): Promise<number | undefined> {
  const key = `${dirPath}\x00${ignorePatterns.join('\x00')}`
  const memoised = roundedCountMemo.get(key)
  if (memoised) return memoised
  const promise = (async (): Promise<number | undefined> => {
    try {
      if (resolve(dirPath) === homedir()) return undefined
      const args = ['--files', '--hidden']
      for (const pattern of ignorePatterns) args.push('--glob', `!${pattern}`)
      const count = await countFilesWithRg(args, dirPath, abortSignal)
      if (count === 0) return 0
      const magnitude = Math.pow(10, Math.floor(Math.log10(count)))
      return Math.round(count / magnitude) * magnitude
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) logError(err)
      return undefined
    }
  })()
  roundedCountMemo.set(key, promise)
  return promise
}
