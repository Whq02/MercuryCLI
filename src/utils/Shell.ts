import { execFile, spawn } from 'node:child_process'
import { closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, join, posix as posixPath, resolve as resolvePath } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd, setCwdState } from '../bootstrap/state.js'
import { generateTaskId } from '../Task.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { errorMessage, isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { onCwdChangedForHooks } from './hooks/fileChangedWatcher.js'
import { logError } from './log.js'
import { getMercuryTempDirName } from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { createBashShellProvider } from './shell/bashProvider.js'
import { resolveShellEngine, runEngineCommand } from './shell/engineSession.js'
import { getInitialSettings } from './settings/settings.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { createPowerShellProvider } from './shell/powershellProvider.js'
import type { ShellProvider, ShellType } from './shell/shellProvider.js'
import { wrapSpawn, createAbortedCommand, createFailedCommand, type ShellCommand } from './ShellCommand.js'
import { subprocessEnv } from './subprocessEnv.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { which } from './which.js'
import { nativeCwdFromShellRecord, posixPathToWindowsPath } from './windowsPaths.js'

export type { ExecResult } from './ShellCommand.js'


const SHELL_FALLBACK_DIRECTORIES = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']

function namesSupportedShell(path: string): boolean {
  return path.includes('bash') || path.includes('zsh')
}

async function isExecutableShell(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    try {
      await new Promise<void>((resolveProbe, rejectProbe) => {
        execFile(path, ['--version'], { windowsHide: true, timeout: 1000, env: { ...subprocessEnv() } }, error => {
          if (error) rejectProbe(error)
          else resolveProbe()
        })
      })
      return true
    } catch {
      return false
    }
  }
}

export async function findSuitableShell(): Promise<string> {
  const loginShell = process.env.SHELL
  const prefersBash = loginShell !== undefined && loginShell.includes('bash')
  const preferredName = prefersBash ? 'bash' : 'zsh'
  const otherName = prefersBash ? 'zsh' : 'bash'

  const [locatedZsh, locatedBash] = await Promise.all([which('zsh'), which('bash')])
  const locatedPreferred = prefersBash ? locatedBash : locatedZsh
  const locatedOther = prefersBash ? locatedZsh : locatedBash

  const candidates: string[] = []
  for (const name of [preferredName, otherName]) {
    for (const directory of SHELL_FALLBACK_DIRECTORIES) {
      candidates.push(join(directory, name))
    }
  }
  if (locatedPreferred) candidates.unshift(locatedPreferred)
  if (locatedOther) candidates.push(locatedOther)
  if (loginShell && namesSupportedShell(loginShell) && (await isExecutableShell(loginShell))) {
    candidates.unshift(loginShell)
  }

  for (const candidate of candidates) {
    if (await isExecutableShell(candidate)) {
      return candidate
    }
  }

  const message =
    'No suitable shell found. Mercury CLI requires a POSIX shell environment (bash or zsh); install one or point the SHELL environment variable at one, then restart Mercury.'
  logError(message)
  throw new Error(message)
}


export type ShellConfig = {
  provider: ShellProvider
}

export const getShellConfig = memoize(async (): Promise<ShellConfig> => {
  const shellPath = await findSuitableShell()
  const provider = await createBashShellProvider(shellPath)
  return { provider }
})

export const getPsProvider = memoize(async (): Promise<ShellProvider> => {
  const powershellPath = await getCachedPowerShellPath()
  if (!powershellPath) {
    throw new Error('PowerShell is not available on this system')
  }
  return createPowerShellProvider(powershellPath)
})

const PROVIDER_TABLE: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => (await getShellConfig()).provider,
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

function directoryResolves(path: string): boolean {
  try {
    getFsImplementation().realpathSync(path)
    return true
  } catch {
    return false
  }
}


const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

export type ExecOptions = {
  timeout?: number
  onProgress?: (
    recentLines: string,
    allLines: string,
    lineCount: number,
    byteCount: number,
    isIncomplete: boolean,
  ) => void
  preventCwdChanges?: boolean
  shouldUseSandbox?: boolean
  shouldAutoBackground?: boolean
  backgroundIntent?: boolean
  onStdout?: (chunk: string) => void
  owner?: string
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

  const sandboxTmpDir = posixPath.join(
    process.env.MERCURY_TMPDIR || '/tmp',
    getMercuryTempDirName(),
  )
  const useSandbox = options.shouldUseSandbox === true

  if (shellType === 'bash' && options.onStdout === undefined && options.backgroundIntent !== true) {
    const engine = resolveShellEngine(getInitialSettings().shellEngine)
    if (engine.engine === 'brush') {
      if (abortSignal.aborted) return createAbortedCommand()
      return runEngineCommand(engine.binaryPath, command, {
        timeout,
        signal: abortSignal,
        sandbox: useSandbox ? { enabled: true, tmpDir: sandboxTmpDir } : { enabled: false },
        onProgress: options.onProgress,
        owner: options.owner,
        onCwd: reported => {
          if (options.preventCwdChanges) return
          try {
            const before = getCwd()
            if (reported.normalize('NFC') !== before.normalize('NFC')) {
              setCwd(reported, before)
              invalidateSessionEnvCache()
              void onCwdChangedForHooks(before, reported)
            }
          } catch (error) {
            logForDebugging(`engine cwd tracking: the session directory stays put — ${errorMessage(error)}`)
          }
        },
      })
    }
  }

  const provider = await PROVIDER_TABLE[shellType]()

  const invocationId = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')

  const built = await provider.buildExecCommand(
    command,
    useSandbox
      ? { id: invocationId, sandboxTmpDir, useSandbox }
      : { id: invocationId, useSandbox },
  )

  let cwd = getCwd()
  if (!directoryResolves(cwd)) {
    const bootDirectory = getOriginalCwd()
    if (directoryResolves(bootDirectory)) {
      setCwdState(bootDirectory)
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

  let finalCommand = built.commandString
  if (useSandbox) {
    const innerShell = shellType === 'powershell' ? '/bin/sh' : provider.shellPath
    finalCommand = await SandboxManager.wrapWithSandbox(finalCommand, innerShell, abortSignal)
    try {
      mkdirSync(sandboxTmpDir, { mode: 0o700 })
    } catch (mkdirError) {
      logForDebugging(`could not create sandbox temp directory ${sandboxTmpDir}: ${errorMessage(mkdirError)}`)
    }
  }

  let spawnFile: string
  let spawnArgs: string[]
  if (useSandbox && shellType === 'powershell') {
    spawnFile = '/bin/sh'
    spawnArgs = ['-c', finalCommand]
  } else {
    spawnFile = provider.shellPath
    spawnArgs = provider.getSpawnArgs(finalCommand)
  }

  const environmentOverrides = await provider.getEnvironmentOverrides(command)

  const taskId = generateTaskId('local_bash')
  const pipeMode = options.onStdout !== undefined
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, !pipeMode)
  await getFsImplementation().mkdir(getTaskOutputDir())

  const childEnv: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    SHELL: shellType === 'bash' ? provider.shellPath : undefined,
    GIT_EDITOR: 'true',
    MERCURY: '1',
    ...environmentOverrides,
  }

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

    const child = spawn(spawnFile, spawnArgs, {
      cwd,
      env: childEnv,
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
      options.shouldAutoBackground ?? false,
    )

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
    return createAbortedCommand(undefined, { code: 126, stderr: errorMessage(spawnError) })
  }

  void shellCommand.result.then(result => {
    if (useSandbox) {
      try {
        SandboxManager.cleanupAfterCommand()
      } catch (cleanupError) {
        logForDebugging(`sandbox cleanup failed: ${errorMessage(cleanupError)}`)
      }
    }

    const cwdFilePath =
      getPlatform() === 'windows' ? posixPathToWindowsPath(built.cwdFilePath) : built.cwdFilePath

    try {
      if (result && !options.preventCwdChanges && shellCommand.status !== 'backgrounded') {
        const record = readFileSync(cwdFilePath, 'utf8')
        const recorded =
          getPlatform() === 'windows' ? nativeCwdFromShellRecord(record) : { path: record.trim() }
        if ('refused' in recorded) {
          logForDebugging(`bash cwd tracking: the session directory stays put — ${recorded.refused}`)
        } else if (recorded.path.normalize('NFC') !== cwdBefore.normalize('NFC')) {
          setCwd(recorded.path, cwdBefore)
          invalidateSessionEnvCache()
          void onCwdChangedForHooks(cwdBefore, recorded.path)
        }
      }
    } catch (error) {
      logForDebugging(`bash cwd tracking: the session directory stays put — ${errorMessage(error)}`)
    }

    void getFsImplementation()
      .unlink(cwdFilePath)
      .catch(() => {
      })
  })

  return shellCommand
}
