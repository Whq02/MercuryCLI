import { execFile, spawn } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { getApiFetch } from '../../platform/network/proxy.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { sleep } from '../../platform/async/sleep.js'
import { writeLocalWindowSetting } from '../roads/local/localWindow.js'
import { readLocalServerSettings } from '../local-server/localServerKnobs.js'
import { readLocalMachineTruth, type LocalServerTruth } from '../local-server/localServerTruth.js'
import { persistModelChoice } from '../../commands/model/persistModelChoice.js'
import { getEngineModel } from '../catalogue/engineModel.js'
import { focusedSessionModelFacts, getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import {
  SETUP_EXEC_TIMEOUT_MS,
  SETUP_INSTALL_WAIT_MS,
  SETUP_PULL_IDLE_MS,
  SETUP_READ_TIMEOUT_MS,
  SETUP_START_WAIT_MS,
  type ExecOptions,
  type ExecResult,
  type SessionModelDoor,
  type SessionModelSetter,
  type SetupIo,
} from './setupTypes.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { envPathDirs, pathLookupExtensions } from '../../platform/host-os/programs.js'
import { commandShellArgv, executableNeedsVerbatimArgs } from '../../platform/host-os/spawn.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export interface ResolvedSetupIo {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  configHome: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
  fetchImpl: typeof fetch
  timeoutMs: number
  startWaitMs: number
  installWaitMs: number
  pullIdleMs: number
  which: (name: string) => Promise<string | undefined>
  exists: (path: string) => boolean
  realpath: (path: string) => string | undefined
  exec: (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>
  totalMemoryBytes: number
  parallelSlots?: number
  cacheType?: string
  readTruth: () => Promise<LocalServerTruth>
  writeWindow: (tag: string, window: number) => void
  focusedConnector: () => SessionModelDoor
  currentModel: () => string | null | undefined
  setAppState?: SessionModelSetter
  persist: (setting: string) => { sentence: string }
}

export function defaultCurrentModel(): string | undefined {
  try {
    return focusedSessionModelFacts()?.effective ?? getEngineModel()
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function lastLineOf(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  return lines[lines.length - 1] ?? ''
}

export function shellArgv(platform: NodeJS.Platform, command: string): string[] {
  return commandShellArgv(command, platform)
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch (error) {
    passedOver(error)
    return false
  }
}

function whichOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (path: string) => boolean = executable): string | undefined {
  const dirs = envPathDirs(env, platform)
  const exts = pathLookupExtensions(env, platform)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

function defaultSleep(ms: number): Promise<void> {
  return sleep(ms, undefined, { unref: true })
}

function defaultExec(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (opts.detached) {
    return new Promise(resolve => {
      try {
        let stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore']
        let fd: number | undefined
        if (opts.logPath) {
          mkdirSync(dirname(opts.logPath), { recursive: true })
          fd = openSync(opts.logPath, 'a')
          stdio = ['ignore', fd, fd]
        }
        const child = spawn(file, args, { detached: true, stdio, cwd: opts.cwd, env: opts.env ?? hostEnv(), windowsHide: true })
        child.on('error', error => resolve({ rc: 1, stdout: '', stderr: String(error), lastLine: String(error), detached: true }))
        child.unref()
        if (fd !== undefined) closeSync(fd)
        startTimeout(() => resolve({ rc: 0, stdout: '', stderr: '', lastLine: `pid ${child.pid ?? '?'}${opts.logPath ? ` · log ${opts.logPath}` : ''}`, ...(child.pid !== undefined ? { pid: child.pid } : {}), detached: true }), 50)
      } catch (error) {
        resolve({ rc: 1, stdout: '', stderr: String(error), lastLine: String(error), detached: true })
      }
    })
  }
  return new Promise(resolve => {
    try {
      const verbatim = executableNeedsVerbatimArgs(file)
      execFile(file, args, { timeout: opts.timeoutMs ?? SETUP_EXEC_TIMEOUT_MS, maxBuffer: 1 << 24, cwd: opts.cwd, env: opts.env ?? hostEnv(), windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}) }, (error, stdout, stderr) => {
        const out = String(stdout)
        const err = String(stderr)
        const rc = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
        resolve({ rc, stdout: out, stderr: err, lastLine: lastLineOf(err !== '' && rc !== 0 ? err : out) || lastLineOf(err) })
      })
    } catch (error) {
      resolve({ rc: 1, stdout: '', stderr: String(error), lastLine: String(error) })
    }
  })
}

function defaultParallelSlots(): number | undefined {
  try {
    return readLocalServerSettings().parallelSlots
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function resolveSetupIo(io: SetupIo = {}): ResolvedSetupIo {
  const env = io.env ?? hostEnv()
  const platform = io.platform ?? process.platform
  const exists = io.exists ?? ((path: string) => existsSync(path))
  const home = io.home ?? homedir()
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const timeoutMs = io.timeoutMs ?? SETUP_READ_TIMEOUT_MS
  const totalMemoryBytes = io.totalMemoryBytes ?? totalmem()
  const parallelSlots = io.parallelSlots ?? defaultParallelSlots()
  return {
    env,
    platform,
    home,
    configHome: io.configHome ?? getMercuryHome(),
    now: io.now ?? Date.now,
    sleep: io.sleep ?? defaultSleep,
    ...(io.signal !== undefined ? { signal: io.signal } : {}),
    fetchImpl,
    timeoutMs,
    startWaitMs: io.startWaitMs ?? SETUP_START_WAIT_MS,
    installWaitMs: io.installWaitMs ?? SETUP_INSTALL_WAIT_MS,
    pullIdleMs: io.pullIdleMs ?? SETUP_PULL_IDLE_MS,
    which: io.which ?? (async name => whichOnPath(name, env, platform, io.exists ?? executable)),
    exists,
    realpath: io.realpath ?? defaultRealpath,
    exec: io.exec ?? defaultExec,
    totalMemoryBytes,
    ...(parallelSlots !== undefined ? { parallelSlots } : {}),
    ...(io.cacheType !== undefined ? { cacheType: io.cacheType } : {}),
    readTruth: io.readTruth ?? (() => readLocalMachineTruth({ env, platform, home, fetchImpl, timeoutMs, totalMemoryBytes }, 'ollama')),
    writeWindow: io.writeWindow ?? ((tag, window) => writeLocalWindowSetting({ id: tag }, window)),
    focusedConnector: io.focusedConnector ?? (() => getFocusedSessionConnector()),
    currentModel: io.currentModel ?? defaultCurrentModel,
    ...(io.setAppState !== undefined ? { setAppState: io.setAppState } : {}),
    persist: io.persist ?? (setting => persistModelChoice(setting)),
  }
}

export async function readJson(io: ResolvedSetupIo, url: string, body?: unknown, timeoutMs: number = io.timeoutMs): Promise<unknown | undefined> {
  const controller = new AbortController()
  const timer = startTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const onOuterAbort = () => controller.abort()
  io.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    io.signal?.throwIfAborted()
    const response = await io.fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch (error) {
    passedOver(error)
    return undefined
  } finally {
    stopTimeout(timer)
    io.signal?.removeEventListener('abort', onOuterAbort)
  }
}

export function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

export function seconds(ms: number): string {
  const s = ms / 1000
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)} s`
}
