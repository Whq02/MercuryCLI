import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flagEnv, stampFlagOnEnv } from '../../platform/substrate/flagRegistry.js'
import { getOriginalCwd, getProjectRoot, getSessionId } from '../../boot/process-state/processState.js'
import { scrubSessionEnvStamps } from '../../platform/substrate/envStamps.js'
import { getExtensionDataDir } from '../extensions/paths.js'
import { recordHookFailure } from '../extensions/health.js'
import { optionSchemaFor } from '../extensions/load/optionSchema.js'
import { loadOptionValues, optionEnv, substituteOptionsInCommand, type OptionValues } from '../extensions/options.js'
import { secondsWord, type HookEnding } from '../../engine/rows/vocabulary.js'
import { formatShellPrefixCommand, shStartLine } from '../../platform/shell/bash/shellPrefix.js'
import { getCwd } from '../../platform/files/cwd.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage, getErrnoCode } from '../../platform/errors/errors.js'
import { pathExists } from '../../platform/files/file.js'
import { getPlatform } from '../../platform/environment/platform.js'
import { endProcessTree } from '../../platform/processes/processGroup.js'
import { getHookEnvFilePath, hookEventWritesEnvFile } from '../../platform/environment/sessionEnvironment.js'
import { getCachedPowerShellPath } from '../../platform/shell/powershellDetection.js'
import { buildPowerShellArgs } from '../../platform/shell/powershellProvider.js'
import { carriedByFile, msysArgvCarries, msysSourceLine, protectBackslashRunsFromMsysArgv } from '../../platform/shell/msysArgv.js'
import { hookBashEnv, hookBashShell, windowsBashRoad } from '../../platform/shell/windowsShellRoad.js'
import { subprocessEnv } from '../../platform/processes/subprocessEnv.js'
import { windowsPathToPosixPath } from '../../platform/files/windowsPaths.js'
import { getHookRunContext } from './hookEvents.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export const HOOK_OUTPUT_MAX_BYTES = 10 * 1024 * 1024
export const HOOK_STREAM_SETTLE_GRACE_MS = 2_000
const TRUNCATION_NOTE = '\n[hook output truncated at 10MB]'

export type CommandHookSource =
  | { kind: 'extension'; id: string; root: string }
  | { kind: 'skill'; root: string }
  | { kind: 'settings' }
  | { kind: 'agent' }

type CommandHookRun = {
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

type CommandHookEnd =
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
    ...scrubSessionEnvStamps(subprocessEnv({ stripProviderCredentials: true })).env,
    MERCURY_PROJECT_DIR: toHookPath(getProjectRoot()),
    MERCURY_SESSION_ID: getHookRunContext()?.sessionId ?? getSessionId(),
    MERCURY_HOOK_EVENT: run.event,
  }
  if (run.source.kind === 'extension') {
    try {
      await stat(run.source.root)
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        throw new Error(`Extension folder does not exist: ${run.source.root} (${run.source.id} — /extensions shows its state)`)
      }
      throw new Error(`Extension folder ${errorMessage(error)}: ${run.source.root} (${run.source.id} — /extensions shows its state)`)
    }
    const rootPath = toHookPath(run.source.root)
    const dataPath = toHookPath(getExtensionDataDir(run.source.id))
    command = command.replace(/\$\{MERCURY_EXTENSION_ROOT\}/g, () => rootPath)
    command = command.replace(/\$\{MERCURY_EXTENSION_DATA\}/g, () => dataPath)
    extensionOptions = loadOptionValues(run.source.id, optionSchemaFor(run.source.id))
    command = substituteOptionsInCommand(command, extensionOptions)
    stampFlagOnEnv(env, 'MERCURY_EXTENSION_ROOT', rootPath)
    stampFlagOnEnv(env, 'MERCURY_EXTENSION_DATA', dataPath)
    Object.assign(env, optionEnv(extensionOptions))
  } else if (run.source.kind === 'skill') {
    stampFlagOnEnv(env, 'MERCURY_EXTENSION_ROOT', toHookPath(run.source.root))
  }
  if (isWindows && !isPowerShell) command = winShHookCommand(command)
  const prefix = flagEnv('MERCURY_SHELL_PREFIX')
  if (!isPowerShell && prefix) command = formatShellPrefixCommand(prefix, isWindows ? command : shStartLine(command))
  if (!isPowerShell && hookEventWritesEnvFile(run.event)) {
    stampFlagOnEnv(env, 'MERCURY_ENV_FILE', await getHookEnvFilePath(run.event, run.index))
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
  const shell = isWindows ? await hookBashShell(run.command) : true
  if (typeof shell === 'string' && windowsBashRoad().kind !== 'engine') return spawnUnderWindowsBash(shell, prepared)
  return spawn(prepared.command, [], { env: isWindows ? hookBashEnv(prepared.env) : prepared.env, cwd: prepared.cwd, shell, windowsHide: true }) as ChildProcessWithoutNullStreams
}

class HookNotHandedOver extends Error {}

function spawnUnderWindowsBash(shell: string, prepared: { command: string; env: NodeJS.ProcessEnv; cwd: string }): ChildProcessWithoutNullStreams {
  const options = { env: hookBashEnv(prepared.env), cwd: prepared.cwd, shell, windowsHide: true }
  if (msysArgvCarries(prepared.command, options.env)) return spawn(protectBackslashRunsFromMsysArgv(prepared.command), [], options) as ChildProcessWithoutNullStreams
  const file = join(tmpdir(), `mercury-hook-${randomBytes(6).toString('hex')}`)
  const mark = randomBytes(6).toString('hex')
  try {
    writeFileSync(file, carriedByFile(prepared.command, mark))
  } catch (error) {
    throw new HookNotHandedOver(`The hook did not run: on Windows a command this long, or any command while MSYS names glob, reaches bash through a file, and that file could not be written (${file}: ${errorMessage(error)}).`)
  }
  const drop = (): void => {
    void unlink(file).catch((error: unknown) => {
      if (getErrnoCode(error) !== 'ENOENT') logForDebugging(`the file that carried a hook's command was not removed (${file}): ${errorMessage(error)}`)
    })
  }
  try {
    const gone = { words: `The hook did not run: the file that carries its command to bash is gone (${file}).`, exit: 2, mark }
    const child = spawn(protectBackslashRunsFromMsysArgv(msysSourceLine(windowsPathToPosixPath(file), gone)), [], options) as ChildProcessWithoutNullStreams
    child.once('close', drop)
    child.once('error', drop)
    return child
  } catch (error) {
    drop()
    throw error
  }
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
    if (error instanceof HookNotHandedOver) return { pid: undefined, result: Promise.resolve({ kind: 'exited', code: 2, stdout: '', stderr: error.message, durationMs: Date.now() - startedAt }), kill: () => {} }
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
    const grace = startTimeout(() => finish(endOf(null)), HOOK_STREAM_SETTLE_GRACE_MS)
    grace.unref?.()
  }
  const clock = startTimeout(() => {
    timedOut = true
    kill()
  }, run.timeoutMs)
  const onAbort = (): void => {
    cancelled = true
    kill()
  }
  run.signal?.addEventListener('abort', onAbort, { once: true })
  if (run.signal?.aborted) onAbort()
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
    stopTimeout(clock)
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
  child.on('error', error => {
    if (getErrnoCode(error) === 'EPIPE') return
    finish({ kind: 'ended', ending: { status: 'failed', class: 'spawn', exit_code: 1, detail: errorMessage(error) }, stdout, stderr, durationMs: Date.now() - startedAt })
  })
  child.once('exit', code => {
    const grace = startTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
      finish(endOf(code))
    }, HOOK_STREAM_SETTLE_GRACE_MS)
    grace.unref?.()
    void streamsEnded.then(() => {
      stopTimeout(grace)
      finish(endOf(code))
    })
  })
  child.stdin.on('error', error => {
    if (getErrnoCode(error) !== 'EPIPE') logForDebugging(`hook ${run.name} stdin: ${errorMessage(error)}`)
  })
  child.stdin.write(run.payloadJson + '\n', 'utf8')
  child.stdin.end()
  return { pid: child.pid, result, kill }
}
