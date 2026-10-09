import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { getOriginalCwd, getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getExtensionDataDir } from '../../extensions/paths.js'
import { recordHookFailure } from '../../extensions/health.js'
import { optionSchemaFor } from '../../extensions/load/optionSchema.js'
import { loadOptionValues, optionEnv, substituteOptionsInCommand, type OptionValues } from '../../extensions/options.js'
import { secondsWord, type HookEnding } from '../../rows/vocabulary.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { pathExists } from '../file.js'
import { getPlatform } from '../platform.js'
import { endProcessTree } from '../processGroup.js'
import { getHookEnvFilePath, hookEventWritesEnvFile } from '../sessionEnvironment.js'
import { getCachedPowerShellPath } from '../shell/powershellDetection.js'
import { buildPowerShellArgs } from '../shell/powershellProvider.js'
import { hookBashShell } from '../shell/windowsShellRoad.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { getHookRunContext } from './hookEvents.js'

export const HOOK_OUTPUT_MAX_BYTES = 10 * 1024 * 1024
export const HOOK_STREAM_SETTLE_GRACE_MS = 2_000
const TRUNCATION_NOTE = '\n[hook output truncated at 10MB]'

export type CommandHookSource =
  | { kind: 'extension'; id: string; root: string }
  | { kind: 'skill'; root: string }
  | { kind: 'settings' }
  | { kind: 'agent' }

export type CommandHookRun = {
  command: string
  shell: 'bash' | 'powershell'
  name: string
  event: string
  index: number
  payloadJson: string
  timeoutMs: number
  signal?: AbortSignal
  source: CommandHookSource
  cwd?: string
  onOutput?: (snapshot: { stdout: string; stderr: string }) => void
}

export type CommandHookEnd =
  | { kind: 'exited'; code: number; stdout: string; stderr: string; durationMs: number }
  | { kind: 'ended'; ending: Extract<HookEnding, { status: 'failed' }>; stdout: string; stderr: string; durationMs: number }

export type CommandHookProcess = {
  pid: number | undefined
  result: Promise<CommandHookEnd>
  kill: () => void
}

export function winShHookCommand(command: string): string {
  const trimmed = command.trim()
  const firstToken = /^("[^"]*\.sh"|'[^']*\.sh'|\S+\.sh)(?:\s|$)/.exec(trimmed)
  if (!firstToken || trimmed.startsWith('bash ')) return command
  const rawFirst = firstToken[1]!
  const unquoted = rawFirst.replace(/^["']|["']$/g, '')
  if (!unquoted.includes('\\')) return `bash ${command}`
  const forward = unquoted.replace(/\\/g, '/')
  const quoted = forward.includes("'") ? `"${forward}"` : `'${forward}'`
  const rest = trimmed.slice(rawFirst.length).trim()
  return rest ? `bash ${quoted} ${rest}` : `bash ${quoted}`
}

function bounded(current: string, chunk: string): string {
  if (current.length >= HOOK_OUTPUT_MAX_BYTES) return current
  const next = current + chunk
  return next.length >= HOOK_OUTPUT_MAX_BYTES ? next.slice(0, HOOK_OUTPUT_MAX_BYTES) + TRUNCATION_NOTE : next
}

async function prepareCommand(run: CommandHookRun): Promise<{ command: string; env: NodeJS.ProcessEnv; cwd: string }> {
  const isWindows = getPlatform() === 'windows'
  const isPowerShell = run.shell === 'powershell'
  const toHookPath = isWindows && !isPowerShell ? (p: string) => windowsPathToPosixPath(p) : (p: string) => p
  let command = run.command
  let extensionOptions: OptionValues | undefined
  const env: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    MERCURY_PROJECT_DIR: toHookPath(getProjectRoot()),
    MERCURY_SESSION_ID: getHookRunContext()?.sessionId ?? getSessionId(),
    MERCURY_HOOK_EVENT: run.event,
  }
  if (run.source.kind === 'extension') {
    if (!(await pathExists(run.source.root))) {
      throw new Error(`Extension folder does not exist: ${run.source.root} (${run.source.id} — /extensions shows its state)`)
    }
    const rootPath = toHookPath(run.source.root)
    const dataPath = toHookPath(getExtensionDataDir(run.source.id))
    command = command.replace(/\$\{MERCURY_EXTENSION_ROOT\}/g, () => rootPath)
    command = command.replace(/\$\{MERCURY_EXTENSION_DATA\}/g, () => dataPath)
    extensionOptions = loadOptionValues(run.source.id, optionSchemaFor(run.source.id))
    command = substituteOptionsInCommand(command, extensionOptions)
    env.MERCURY_EXTENSION_ROOT = rootPath
    env.MERCURY_EXTENSION_DATA = dataPath
    Object.assign(env, optionEnv(extensionOptions))
  } else if (run.source.kind === 'skill') {
    env.MERCURY_EXTENSION_ROOT = toHookPath(run.source.root)
  }
  if (isWindows && !isPowerShell) command = winShHookCommand(command)
  const prefix = process.env.MERCURY_SHELL_PREFIX
  if (!isPowerShell && prefix) command = formatShellPrefixCommand(prefix, command)
  if (!isPowerShell && hookEventWritesEnvFile(run.event)) {
    env.MERCURY_ENV_FILE = await getHookEnvFilePath(run.event, run.index)
  }
  const wanted = run.cwd ?? getHookRunContext()?.cwd ?? getCwd()
  const cwd = (await pathExists(wanted)) ? wanted : getOriginalCwd()
  if (cwd !== wanted) logForDebugging(`hook cwd ${wanted} is gone; running in ${cwd} instead`, { level: 'warn' })
  return { command, env, cwd }
}

async function spawnHook(run: CommandHookRun, prepared: { command: string; env: NodeJS.ProcessEnv; cwd: string }): Promise<ChildProcessWithoutNullStreams> {
  const isWindows = getPlatform() === 'windows'
  if (run.shell === 'powershell') {
    const pwsh = await getCachedPowerShellPath()
    if (!pwsh) {
      throw new Error(`No PowerShell on PATH (pwsh or powershell) for hook "${run.command}", which asks for it: install PowerShell, or remove "shell": "powershell" so the hook runs under bash.`)
    }
    return spawn(pwsh, buildPowerShellArgs(prepared.command), { env: prepared.env, cwd: prepared.cwd, windowsHide: true }) as ChildProcessWithoutNullStreams
  }
  const shell = isWindows ? hookBashShell(run.command) : true
  return spawn(prepared.command, [], { env: prepared.env, cwd: prepared.cwd, shell, windowsHide: true }) as ChildProcessWithoutNullStreams
}

function endedEarly(run: CommandHookRun, ending: Extract<HookEnding, { status: 'failed' }>, startedAt: number): CommandHookProcess {
  const end: CommandHookEnd = { kind: 'ended', ending, stdout: '', stderr: '', durationMs: Date.now() - startedAt }
  if (run.source.kind === 'extension') recordHookFailure(run.source.id, run.command, ending.class === 'spawn' ? (ending.detail ?? 'could not run') : ending.class)
  return { pid: undefined, result: Promise.resolve(end), kill: () => {} }
}

export async function startCommandHook(run: CommandHookRun): Promise<CommandHookProcess> {
  const startedAt = Date.now()
  if (run.signal?.aborted) return endedEarly(run, { status: 'failed', class: 'cancelled', exit_code: 1 }, startedAt)
  let child: ChildProcessWithoutNullStreams
  try {
    child = await spawnHook(run, await prepareCommand(run))
  } catch (error) {
    return endedEarly(run, { status: 'failed', class: 'spawn', exit_code: 1, detail: errorMessage(error) }, startedAt)
  }
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let cancelled = false
  let settled = false
  let settle: (end: CommandHookEnd) => void = () => {}
  const result = new Promise<CommandHookEnd>(resolve => {
    settle = end => {
      if (settled) return
      settled = true
      resolve(end)
    }
  })
  const kill = (): void => {
    void endProcessTree(child, 'SIGKILL')
    const grace = setTimeout(() => finish(endOf(null)), HOOK_STREAM_SETTLE_GRACE_MS)
    grace.unref?.()
  }
  const clock = setTimeout(() => {
    timedOut = true
    kill()
  }, run.timeoutMs)
  const onAbort = (): void => {
    cancelled = true
    kill()
  }
  run.signal?.addEventListener('abort', onAbort, { once: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout = bounded(stdout, chunk)
    run.onOutput?.({ stdout, stderr })
  })
  child.stderr.on('data', (chunk: string) => {
    stderr = bounded(stderr, chunk)
    run.onOutput?.({ stdout, stderr })
  })
  const finish = (end: CommandHookEnd): void => {
    clearTimeout(clock)
    run.signal?.removeEventListener('abort', onAbort)
    if (end.kind === 'ended' && run.source.kind === 'extension') recordHookFailure(run.source.id, run.command, end.ending.class === 'spawn' ? (end.ending.detail ?? 'could not run') : end.ending.class)
    settle(end)
  }
  const endOf = (code: number | null): CommandHookEnd => {
    const durationMs = Date.now() - startedAt
    if (timedOut) return { kind: 'ended', ending: { status: 'failed', class: 'timed_out', exit_code: code ?? 143, detail: secondsWord(run.timeoutMs) }, stdout, stderr, durationMs }
    if (cancelled) return { kind: 'ended', ending: { status: 'failed', class: 'cancelled', exit_code: code ?? 137 }, stdout, stderr, durationMs }
    return { kind: 'exited', code: code ?? 1, stdout, stderr, durationMs }
  }
  const streamsEnded = Promise.all([
    new Promise<void>(resolve => child.stdout.once('end', () => resolve())),
    new Promise<void>(resolve => child.stderr.once('end', () => resolve())),
  ])
  child.once('error', error => {
    const code = getErrnoCode(error)
    const ending: Extract<HookEnding, { status: 'failed' }> = code === 'EPIPE'
      ? { status: 'failed', class: 'closed_pipe', exit_code: 1 }
      : { status: 'failed', class: 'spawn', exit_code: 1, detail: errorMessage(error) }
    finish({ kind: 'ended', ending, stdout, stderr, durationMs: Date.now() - startedAt })
  })
  child.once('exit', code => {
    const grace = setTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
      finish(endOf(code))
    }, HOOK_STREAM_SETTLE_GRACE_MS)
    grace.unref?.()
    void streamsEnded.then(() => {
      clearTimeout(grace)
      finish(endOf(code))
    })
  })
  child.stdin.on('error', error => {
    if (getErrnoCode(error) === 'EPIPE') {
      finish({ kind: 'ended', ending: { status: 'failed', class: 'closed_pipe', exit_code: 1 }, stdout, stderr, durationMs: Date.now() - startedAt })
      return
    }
    logForDebugging(`hook ${run.name} stdin: ${errorMessage(error)}`)
  })
  child.stdin.write(run.payloadJson + '\n', 'utf8')
  child.stdin.end()
  return { pid: child.pid, result, kill }
}
