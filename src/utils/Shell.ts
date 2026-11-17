import { spawnOwnedShell } from './shell/parentGuard.js'
import { closeSync, constants as fsConstants, openSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd, setCwdState, subscribeCwdState } from '../bootstrap/state.js'
import { generateTaskId } from '../Task.js'
import { contextShellCwd, getCwd, getStartingCwd, setContextShellCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
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
import { toolShellEnv, subprocessEnv } from './subprocessEnv.js'
import { scrubSessionEnvStamps } from '../substrate/envStamps.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { nativeCwdFromShellRecord, posixPathToWindowsPath } from './windowsPaths.js'
import { planWindowsBatchInvocation, runWindowsBatchCommand } from './shell/windowsBatchInvocation.js'
import { withGitPrograms } from './shell/windowsShellRoad.js'

type ShellConfig = {
  provider: ShellProvider
}

export const getShellConfig = memoize(async (): Promise<ShellConfig> => {
  const provider = await createBashShellProvider(await systemShellRecord())
  return { provider }
})

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

  const engineBinary = shellType === 'bash' ? perCommandEngineBinary(getInitialSettings().shell?.engine) : null
  const provider = engineBinary === null ? await PROVIDER_TABLE[shellType]() : createEngineCommandProvider(engineBinary)

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

  if (abortSignal.aborted) {
    return createAbortedCommand()
  }

  const spawnFile = provider.shellPath
  const spawnArgs = provider.getSpawnArgs(built.commandString)

  const environmentOverrides = await provider.getEnvironmentOverrides(command)

  const taskId = generateTaskId('local_bash')
  const pipeMode = options.onStdout !== undefined
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, !pipeMode)
  await getFsImplementation().mkdir(getTaskOutputDir())

  const base = options.inheritSessionEnv === true
    ? { env: subprocessEnv(), scrubbed: [] as string[] }
    : scrubSessionEnvStamps(subprocessEnv())

  const childEnv = toolShellEnv(base.env, {
    SHELL: shellType === 'bash' ? provider.shellPath : undefined,
    ...environmentOverrides,
  })

  const cwdBefore = cwd
  let outputFd: number | undefined
  let shellCommand: ShellCommand
  try {
    let stdio: ('pipe' | 'ignore' | number)[]
    if (pipeMode) {
      stdio = ['pipe', 'pipe', 'pipe']
    } else {
      outputFd = openTaskOutputFile(taskOutput.path)
      stdio = ['pipe', outputFd, outputFd]
    }

    const child = await spawnOwnedShell(spawnFile, spawnArgs, {
      cwd,
      env: engineBinary === null ? childEnv : withGitPrograms(childEnv),
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
    shellCommand.scrubbedSessionEnv = base.scrubbed

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
    logForDebugging(`spawn failed for shell command: ${errorMessage(spawnError)}`)
    const code = (spawnError as NodeJS.ErrnoException).code
    const message = errorMessage(spawnError)
    return createFailedCommand(code === 'ENAMETOOLONG' || code === 'E2BIG'
      ? `The shell command exceeds the platform's command-line limit (${code}). Put the command in a script file and run that file instead. ${message}`
      : message)
  }

  void shellCommand.result.then(result => {
    const cwdFilePath =
      getPlatform() === 'windows' ? posixPathToWindowsPath(built.cwdFilePath) : built.cwdFilePath

    try {
      if (result && !options.preventCwdChanges && cwdOverride === undefined && result.backgroundTaskId === undefined) {
        const record = readFileSync(cwdFilePath, 'utf8')
        const recorded =
          getPlatform() === 'windows' ? nativeCwdFromShellRecord(record) : { path: record.trim() }
        if ('refused' in recorded) {
          logForDebugging(`bash cwd tracking: the shell directory stays put — ${recorded.refused}`)
        } else if (recorded.path.normalize('NFC') !== cwdBefore.normalize('NFC')) {
          recordShellCwd(recorded.path, cwdBefore)
          invalidateSessionEnvCache()
        }
      }
    } catch (error) {
      logForDebugging(`bash cwd tracking: the shell directory stays put — ${errorMessage(error)}`)
    }

    if (built.pipelineStatusPath !== undefined) {
      const file = getPlatform() === 'windows' ? posixPathToWindowsPath(built.pipelineStatusPath) : built.pipelineStatusPath
      try {
        const text = readFileSync(file, 'utf8').trim()
        if (/^\d+(?:\s+\d+)+$/.test(text)) result.pipelineStatus = text.split(/\s+/).map(Number)
      } catch {}
      void getFsImplementation().unlink(file).catch(() => {})
    }
    void getFsImplementation()
      .unlink(cwdFilePath)
      .catch(() => {
      })
  })

  return shellCommand
}
