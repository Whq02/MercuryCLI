import { spawnOwnedShell } from './shell/parentGuard.js'
import { closeSync, constants as fsConstants, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd, setCwdState, subscribeCwdState } from '../bootstrap/state.js'
import { generateTaskId } from '../Task.js'
import { createAndSaveSnapshot, loginExports } from './bash/ShellSnapshot.js'
import { contextShellCwd, getCwd, getStartingCwd, setContextShellCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { diagnosticAsksFor, isReadOnlyDiagnostic } from './diagnosticReadOnly.js'
import { errorMessage, isENOENT } from './errors.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { createBashShellProvider } from './shell/bashProvider.js'
import { createEngineCommandProvider, perCommandEngineBinary, resolveShellEngine, runEngineCommand, resolveEngineSessionCeiling } from './shell/engineSession.js'
import { getInitialSettings } from './settings/settings.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { createPowerShellProvider } from './shell/powershellProvider.js'
import type { ShellProvider, ShellType } from './shell/shellProvider.js'
import { fallbackEngineBinary, systemShellRecord } from './shell/shellRecord.js'
import { wrapSpawn, createAbortedCommand, createFailedCommand, type ShellCommand } from './ShellCommand.js'
import { toolShellEnv, subprocessEnv, withLoginExports } from './subprocessEnv.js'
import { scrubSessionEnvStamps } from '../substrate/envStamps.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { WINDOWS_STARTS_A_PROGRAM_IN, nativeCwdFromShellRecord, posixPathToWindowsPath } from './windowsPaths.js'
import { planWindowsBatchInvocation, runWindowsBatchCommand } from './shell/windowsBatchInvocation.js'
import { windowsShellRoadActive, withRoadPrograms } from './shell/windowsShellRoad.js'

type ShellConfig = {
  provider: ShellProvider
}

export const getShellConfig = memoize(async (): Promise<ShellConfig> => {
  const provider = await createBashShellProvider(await systemShellRecord())
  return { provider }
})

const loginFilesAsked = memoize(async (): Promise<void> => {
  await createAndSaveSnapshot(await systemShellRecord(), { keptNowhere: true })
})

export async function settleLoginFiles(): Promise<void> {
  try {
    if (windowsShellRoadActive() || resolveShellEngine(getInitialSettings().shell?.engine).engine === 'brush') return
    if (isReadOnlyDiagnostic() && !diagnosticAsksFor('shell')) return
    if ((await fallbackEngineBinary()) !== null) return
    await (isReadOnlyDiagnostic() ? loginFilesAsked() : getShellConfig())
  } catch (error) {
    logForDebugging(`the login files are not settled: ${errorMessage(error)}`)
  }
}

const getPsProvider = memoize(async (): Promise<ShellProvider> => {
  const powershellPath = await getCachedPowerShellPath()
  if (!powershellPath) {
    throw new Error('PowerShell is not available on this system')
  }
  return createPowerShellProvider(powershellPath)
})

const PROVIDER_TABLE: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => {
    const fallback = await fallbackEngineBinary()
    return fallback === null ? (await getShellConfig()).provider : createEngineCommandProvider(fallback)
  },
  powershell: () => getPsProvider(),
}

type SpawnRoad = { provider: ShellProvider; engineBinary: string | null; recordsBash: boolean }

async function spawnRoad(shellType: ShellType): Promise<SpawnRoad> {
  const engineBinary = shellType === 'bash' ? perCommandEngineBinary(getInitialSettings().shell?.engine) : null
  const provider = engineBinary === null ? await PROVIDER_TABLE[shellType]() : createEngineCommandProvider(engineBinary)
  const recordsBash = shellType === 'bash' && engineBinary === null && !windowsShellRoadActive() && (await fallbackEngineBinary()) === null
  return { provider, engineBinary, recordsBash }
}

async function commandEnvironment(
  road: SpawnRoad,
  shellType: ShellType,
  command: string,
  inheritSessionEnv: boolean,
): Promise<{ env: NodeJS.ProcessEnv; scrubbed: string[] }> {
  const environmentOverrides = await road.provider.getEnvironmentOverrides(command)
  const base = inheritSessionEnv
    ? { env: subprocessEnv(), scrubbed: [] as string[] }
    : scrubSessionEnvStamps(subprocessEnv())
  const env = toolShellEnv(base.env, {
    ...(road.recordsBash ? {} : { SHELL: shellType === 'bash' ? road.provider.shellPath : undefined }),
    ...environmentOverrides,
  })
  return { env: shellType === 'bash' ? withLoginExports(env, loginExports(road.provider.shellPath), base.scrubbed) : env, scrubbed: base.scrubbed }
}

export async function terminalShellInvocation(
  command: string,
  inheritSessionEnv: boolean,
): Promise<{
  file: string
  args: string[]
  argsFor: (line: string) => string[]
  env: NodeJS.ProcessEnv
  scrubbed: string[]
  leftBehind: string[]
}> {
  const road = await spawnRoad('bash')
  const invocationId = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
  const built = await road.provider.buildExecCommand(command, { id: invocationId })
  const { env, scrubbed } = await commandEnvironment(road, 'bash', command, inheritSessionEnv)
  const native = (path: string): string => (getPlatform() === 'windows' ? posixPathToWindowsPath(path) : path)
  const handed = built.handOver?.(env)
  if (handed?.file !== undefined) writeFileSync(handed.file.path, handed.file.text)
  return {
    file: road.provider.shellPath,
    args: handed?.args ?? road.provider.getSpawnArgs(built.commandString),
    argsFor: line => road.provider.getSpawnArgs(line),
    env: road.provider.origin === undefined ? env : withRoadPrograms(env, road.provider.origin, road.provider.shellPath),
    scrubbed,
    leftBehind: [...[built.cwdFilePath, ...(built.pipelineStatusPath === undefined ? [] : [built.pipelineStatusPath])].map(native), ...(handed?.file === undefined ? [] : [handed.file.path])],
  }
}

const SHELL_ENDED_UNREAD =
  'The shell ended before it read this command, so nothing ran. A file the shell reads when it starts can end it or hand it to another program: BASH_ENV names such a file.'

const FRAME_UNREAD = 'the shell has not read this command\n'

function markFrameUnread(path: string): void {
  try {
    writeFileSync(path, FRAME_UNREAD)
  } catch (error) {
    logForDebugging(`no mark of an unread command at ${path}: ${errorMessage(error)}`)
  }
}

async function shellGoneWords(shellPath: string): Promise<string> {
  const origin = (await systemShellRecord()).origin
  const which = origin === 'shipped' ? 'the bash Mercury ships' : "the system's bash"
  return `The shell this session runs commands in is gone: ${which} was at ${shellPath} and that file is no longer there. A session keeps its shell for its life, so no command can run in this one; restart Mercury and the new session takes the next road (${origin === 'shipped' ? "the system's bash, then the bundled engine" : 'another bash on this machine, then the bundled engine'}).`
}


export function setCwd(path: string, base?: string): void {
  const fs = getFsImplementation()
  const resolved = isAbsolute(path) ? path : resolvePath(base ?? fs.cwd(), path)
  let physical: string
  try {
    physical = fs.realpathSync(resolved)
  } catch (error) {
    if (isENOENT(error)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }
    throw error
  }
  setCwdState(physical)
}

let shellCwd: string | null = null
subscribeCwdState(() => {
  shellCwd = null
})

function readShellCwd(): string | null {
  const own = contextShellCwd()
  return own === undefined ? shellCwd : own
}

function writeShellCwd(next: string | null): void {
  if (!setContextShellCwd(next)) shellCwd = next
}

export function getShellCwd(): string {
  const last = readShellCwd()
  if (last !== null && directoryResolves(last)) return last
  writeShellCwd(null)
  return getCwd()
}

export function resolveShellCwd(cwd?: string): string {
  if (cwd === undefined) return getShellCwd()
  const absolute = isAbsolute(cwd) ? cwd : resolvePath(getStartingCwd(), cwd)
  return safeResolvePath(getFsImplementation(), absolute).resolvedPath
}

function recordShellCwd(path: string, base: string): void {
  const resolved = isAbsolute(path) ? path : resolvePath(base, path)
  writeShellCwd(getFsImplementation().realpathSync(resolved).normalize('NFC'))
}

const NO_PROGRAM_STARTS_PAST = `Windows starts no program in a folder whose path is longer than ${WINDOWS_STARTS_A_PROGRAM_IN} characters`

function shellDirectoryStays(before: string, why: string): string {
  return `The shell's directory stays ${before}: ${why}.`
}

function startRefusal(folder: string, tracked: boolean): string | null {
  if (getPlatform() !== 'windows' || folder.length <= WINDOWS_STARTS_A_PROGRAM_IN) return null
  return shellDirectoryStays(tracked ? folder : getShellCwd(), `${NO_PROGRAM_STARTS_PAST}, and ${tracked ? 'this one' : folder} has ${folder.length}, so the command was not started${tracked ? '; cd to a shorter folder with the Bash tool' : ''}`)
}

function folderNoProgramStartsIn(path: string, base: string): string | null {
  if (getPlatform() !== 'windows') return null
  const physical = getFsImplementation().realpathSync(isAbsolute(path) ? path : resolvePath(base, path))
  return physical.length > WINDOWS_STARTS_A_PROGRAM_IN ? shellDirectoryStays(base, `${NO_PROGRAM_STARTS_PAST}, and ${physical} has ${physical.length}; name such a folder by its path`) : null
}

function directoryResolves(path: string): boolean {
  try {
    getFsImplementation().realpathSync(path)
    return true
  } catch {
    return false
  }
}


const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

type ExecOptions = {
  cwd?: string
  timeout?: number
  onProgress?: (
    recentLines: string,
    allLines: string,
    lineCount: number,
    byteCount: number,
    isIncomplete: boolean,
  ) => void
  preventCwdChanges?: boolean
  shouldAutoBackground?: boolean
  backgroundIntent?: boolean
  onStdout?: (chunk: string) => void
  owner?: string
  inheritSessionEnv?: boolean
}

function openTaskOutputFile(path: string): number {
  if (getPlatform() === 'windows') {
    return openSync(path, 'w')
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  return openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow)
}

export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options: ExecOptions = {},
): Promise<ShellCommand> {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS
  const cwdOverride = options.cwd === undefined ? undefined : resolveShellCwd(options.cwd)
  if (cwdOverride !== undefined && !directoryResolves(cwdOverride)) return createFailedCommand(`Path "${cwdOverride}" does not exist`)

  if (shellType === 'bash' && options.onStdout === undefined && options.backgroundIntent !== true && options.inheritSessionEnv !== true) {
    const engine = resolveShellEngine(getInitialSettings().shell?.engine)
    const sessionBinary = engine.engine === 'brush' ? engine.binaryPath : await fallbackEngineBinary()
    if (sessionBinary !== null) {
      if (abortSignal.aborted) return createAbortedCommand()
      return runEngineCommand(sessionBinary, command, {
        timeout,
        signal: abortSignal,
        onProgress: options.onProgress,
        owner: options.owner,
        sessionCeiling: resolveEngineSessionCeiling(getInitialSettings().shell?.sessions),
        cwd: cwdOverride ?? getShellCwd(),
        requireCwd: cwdOverride !== undefined,
        onCwd: reported => {
          if (options.preventCwdChanges || cwdOverride !== undefined) return
          try {
            const before = getShellCwd()
            if (reported.normalize('NFC') !== before.normalize('NFC')) {
              recordShellCwd(reported, before)
              invalidateSessionEnvCache()
            }
          } catch (error) {
            logForDebugging(`engine cwd tracking: the shell directory stays put — ${errorMessage(error)}`)
          }
        },
      })
    }
  }

  if (
    shellType === 'bash' &&
    getPlatform() === 'windows' &&
    !abortSignal.aborted &&
    resolveShellEngine(getInitialSettings().shell?.engine).engine === 'system'
  ) {
    const shellDirectory = cwdOverride ?? getShellCwd()
    if (directoryResolves(shellDirectory)) {
      const invocation = await planWindowsBatchInvocation(command, { cwd: shellDirectory })
      if (invocation.kind === 'batch') {
        const unstartable = startRefusal(shellDirectory, cwdOverride === undefined)
        if (unstartable !== null) return createFailedCommand(unstartable)
        logForDebugging(`batch invocation through cmd.exe: ${invocation.batchPath}`)
        return await runWindowsBatchCommand(invocation, abortSignal, {
          timeout,
          cwd: shellDirectory,
          shouldAutoBackground: options.shouldAutoBackground ?? false,
          inheritSessionEnv: options.inheritSessionEnv === true,
          ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
          ...(options.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        })
      }
    }
  }

  const road = await spawnRoad(shellType)
  const { provider, engineBinary } = road

  const invocationId = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')

  const built = await provider.buildExecCommand(command, { id: invocationId })

  let cwd = cwdOverride ?? getShellCwd()
  if (!directoryResolves(cwd)) {
    if (cwdOverride !== undefined) return createFailedCommand(`Path "${cwdOverride}" does not exist`)
    const bootDirectory = getOriginalCwd()
    if (directoryResolves(bootDirectory)) {
      if (contextShellCwd() === undefined) setCwdState(bootDirectory)
      writeShellCwd(null)
      logForDebugging(
        `working directory ${cwd} no longer exists; recovered to the original directory ${bootDirectory}`,
      )
      cwd = bootDirectory
    } else {
      return createFailedCommand(
        `The working directory ${cwd} no longer exists, and the original startup directory is gone too. Restart Mercury from an existing directory.`,
      )
    }
  }

  const refusal = built.handOver === undefined ? startRefusal(cwd, cwdOverride === undefined) : null
  if (refusal !== null) return createFailedCommand(refusal)

  if (abortSignal.aborted) {
    return createAbortedCommand()
  }

  const spawnFile = provider.shellPath
  const spawnArgs = provider.getSpawnArgs(built.commandString)

  const taskId = generateTaskId('local_bash')
  const pipeMode = options.onStdout !== undefined
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, !pipeMode)
  await getFsImplementation().mkdir(getTaskOutputDir())

  const { env: childEnv, scrubbed } = await commandEnvironment(road, shellType, command, options.inheritSessionEnv === true)

  const cwdBefore = cwd
  let outputFd: number | undefined
  let shellCommand: ShellCommand
  if (road.recordsBash) markFrameUnread(built.cwdFilePath)
  const handed = built.handOver?.(childEnv, cwd)
  const dropFrame = (): void => {
    if (handed?.file !== undefined) void getFsImplementation().unlink(handed.file.path).catch(() => {})
  }
  try {
    if (handed?.file !== undefined) writeFileSync(handed.file.path, handed.file.text)
    let stdio: ('pipe' | 'ignore' | number)[]
    if (pipeMode) {
      stdio = ['pipe', 'pipe', 'pipe']
    } else {
      outputFd = openTaskOutputFile(taskOutput.path)
      stdio = ['pipe', outputFd, outputFd]
    }

    const child = await spawnOwnedShell(spawnFile, handed?.args ?? spawnArgs, {
      cwd: handed?.startIn ?? cwd,
      env: provider.origin === undefined ? childEnv : withRoadPrograms(childEnv, provider.origin, provider.shellPath),
      stdio,
      detached: provider.detached,
      windowsHide: true,
    })
    try {
      child.stdin?.end()
    } catch {
    }

    shellCommand = wrapSpawn(
      child,
      abortSignal,
      timeout,
      taskOutput,
      engineBinary === null && (options.shouldAutoBackground ?? false),
    )
    shellCommand.scrubbedSessionEnv = scrubbed

    if (outputFd !== undefined) {
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
      try {
        closeSync(outputFd)
      } catch (closeError) {
        logForDebugging(`failed to close task output descriptor: ${errorMessage(closeError)}`)
      }
      outputFd = undefined
    }

    if (pipeMode) {
      const onStdout = options.onStdout as (chunk: string) => void
      child.stdout?.on('data', (chunk: string | Buffer) => {
        onStdout(typeof chunk === 'string' ? chunk : chunk.toString())
      })
    }
  } catch (spawnError) {
    if (outputFd !== undefined) {
      try {
        closeSync(outputFd)
      } catch {
      }
    }
    taskOutput.clear()
    dropFrame()
    if (road.recordsBash) void Promise.allSettled([getFsImplementation().unlink(built.cwdFilePath)])
    logForDebugging(`spawn failed for shell command: ${errorMessage(spawnError)}`)
    const code = (spawnError as NodeJS.ErrnoException).code
    const message = errorMessage(spawnError)
    if (road.recordsBash && code === 'ENOENT' && !existsSync(spawnFile)) return createFailedCommand(await shellGoneWords(spawnFile))
    return createFailedCommand(code === 'ENAMETOOLONG' || code === 'E2BIG'
      ? `The shell command exceeds the platform's command-line limit (${code}). Put the command in a script file and run that file instead. ${message}`
      : message)
  }

  void shellCommand.result.then(result => {
    const cwdFilePath =
      getPlatform() === 'windows' ? posixPathToWindowsPath(built.cwdFilePath) : built.cwdFilePath

    const told = (line: string): void => {
      result.stderr = result.stderr === '' ? line : `${result.stderr}\n${line}`
    }
    let named: string | undefined
    try {
      const record = readFileSync(cwdFilePath, 'utf8')
      if (road.recordsBash && record === FRAME_UNREAD) {
        if (!result.interrupted && result.backgroundTaskId === undefined) {
          result.stderr = result.stderr === '' ? SHELL_ENDED_UNREAD : `${result.stderr}\n${SHELL_ENDED_UNREAD}`
          if (result.code === 0) result.code = 126
        }
      } else if (result && !options.preventCwdChanges && cwdOverride === undefined && result.backgroundTaskId === undefined) {
        const recorded =
          getPlatform() === 'windows' ? nativeCwdFromShellRecord(record) : { path: record.trim() }
        if (road.recordsBash && record.trim() === '') {
          logForDebugging('bash cwd tracking: the shell directory stays put — the command left no directory')
        } else if ('refused' in recorded) {
          logForDebugging(`bash cwd tracking: the shell directory stays put — ${recorded.refused}`)
          if (record.trim() !== '') told(shellDirectoryStays(cwdBefore, `${record.trim().split(/\r?\n/)[0]} is a folder of the bash's own with no Windows path`))
        } else if (recorded.path.normalize('NFC') !== cwdBefore.normalize('NFC')) {
          named = recorded.path
          const unstartable = built.handOver === undefined ? folderNoProgramStartsIn(recorded.path, cwdBefore) : null
          if (unstartable !== null) {
            told(unstartable)
          } else {
            recordShellCwd(recorded.path, cwdBefore)
            invalidateSessionEnvCache()
          }
          named = undefined
        }
      }
    } catch (error) {
      logForDebugging(`bash cwd tracking: the shell directory stays put — ${errorMessage(error)}`)
      if (named !== undefined && getPlatform() === 'windows') told(shellDirectoryStays(cwdBefore, `${named} does not resolve (${errorMessage(error)})`))
    }

    if (built.pipelineStatusPath !== undefined) {
      const file = getPlatform() === 'windows' ? posixPathToWindowsPath(built.pipelineStatusPath) : built.pipelineStatusPath
      try {
        const text = readFileSync(file, 'utf8').trim()
        if (/^\d+(?:\s+\d+)+$/.test(text)) result.pipelineStatus = text.split(/\s+/).map(Number)
      } catch {}
      void getFsImplementation().unlink(file).catch(() => {})
    }
    dropFrame()
    void getFsImplementation()
      .unlink(cwdFilePath)
      .catch(() => {
      })
  })

  return shellCommand
}
