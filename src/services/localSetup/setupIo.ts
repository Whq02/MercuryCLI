import { execFile, spawn } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { getApiFetch } from '../../utils/proxy.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { writeLocalWindowSetting } from '../providers/local/localWindow.js'
import { readLocalServerSettings } from '../localServer/localServerKnobs.js'
import { readLocalMachineTruth, type LocalServerTruth } from '../localServer/localServerTruth.js'
import { persistModelChoice } from '../../commands/model/persistModelChoice.js'
import { getEngineModel } from '../../utils/model/model.js'
import { focusedSessionModelFacts, getFocusedSessionConnector } from '../engine-connector/focusedConnector.js'
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

function defaultCurrentModel(): string | undefined {
  try {
    return focusedSessionModelFacts()?.effective ?? getEngineModel()
  } catch {
    return undefined
  }
}

export function lastLineOf(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  return lines[lines.length - 1] ?? ''
}

export function shellArgv(platform: NodeJS.Platform, command: string): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', command] : ['/bin/sh', '-c', command]
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function whichOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (path: string) => boolean = executable): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(dir => dir !== '')
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(ext => ext !== '') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`)
      if (exists(candidate)) return candidate
    }
    if (platform === 'win32' && exists(join(dir, name))) return join(dir, name)
  }
  return undefined
}

function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
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
        const child = spawn(file, args, { detached: true, stdio, cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true })
        child.on('error', error => resolve({ rc: 1, stdout: '', stderr: String(error), lastLine: String(error), detached: true }))
        child.unref()
        if (fd !== undefined) closeSync(fd)
        setTimeout(() => resolve({ rc: 0, stdout: '', stderr: '', lastLine: `pid ${child.pid ?? '?'}${opts.logPath ? ` · log ${opts.logPath}` : ''}`, ...(child.pid !== undefined ? { pid: child.pid } : {}), detached: true }), 50)
      } catch (error) {
        resolve({ rc: 1, stdout: '', stderr: String(error), lastLine: String(error), detached: true })
      }
    })
  }
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout: opts.timeoutMs ?? SETUP_EXEC_TIMEOUT_MS, maxBuffer: 1 << 24, cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true }, (error, stdout, stderr) => {
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
  } catch {
    return undefined
  }
}

export function resolveSetupIo(io: SetupIo = {}): ResolvedSetupIo {
  const env = io.env ?? process.env
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
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const onOuterAbort = () => controller.abort()
  io.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await io.fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
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
