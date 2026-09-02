/**
 * Shell discovery and the one process-spawning entry that runs a user shell
 * command and tracks the working directory across it.
 *
 * Everything here routes through the two-shell provider table (bash /
 * PowerShell). The provider builds the invocation; this module resolves the
 * working directory (recovering when a command deleted its own cwd), spawns
 * the child, wires its output into the task-output machinery, and propagates
 * any directory change back into the session when the result settles.
 */
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
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { createPowerShellProvider } from './shell/powershellProvider.js'
import type { ShellProvider, ShellType } from './shell/shellProvider.js'
import { wrapSpawn, createAbortedCommand, createFailedCommand, type ShellCommand } from './ShellCommand.js'
import { subprocessEnv } from './subprocessEnv.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { which } from './which.js'
import { nativeCwdFromShellRecord, posixPathToWindowsPath } from './windowsPaths.js'

// One import site for callers that need the settled result type.
export type { ExecResult } from './ShellCommand.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shell discovery
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed fallback directories crossed with the two shell names (shell-major). */
const SHELL_FALLBACK_DIRECTORIES = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']

/** A path names a supported shell family for discovery purposes. */
function namesSupportedShell(path: string): boolean {
  return path.includes('bash') || path.includes('zsh')
}

/**
 * One predicate answers both "exists" and "is executable": the access test
 * for the execute bit also fails for a missing path. Because that test is
 * unreliable in some environments (notably Nix), a failure falls back to
 * actually invoking the candidate with `--version` under a one-second
 * timeout with its output discarded — success means executable, any throw
 * means not. The fallback never goes through a shell: this is a
 * command-injection boundary.
 */
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

/**
 * Discover the shell binary to run commands with. Order of consideration:
 * the user's `SHELL` when it names bash or zsh (which also sets the family
 * preference); binaries located on PATH; and the fixed fallback locations.
 */
export async function findSuitableShell(): Promise<string> {
  const loginShell = process.env.SHELL
  // A bash login shell prefers the bash family; anything else — including an
  // unset SHELL or a third shell — prefers zsh.
  const prefersBash = loginShell !== undefined && loginShell.includes('bash')
  const preferredName = prefersBash ? 'bash' : 'zsh'
  const otherName = prefersBash ? 'zsh' : 'bash'

  const [locatedZsh, locatedBash] = await Promise.all([which('zsh'), which('bash')])
  const locatedPreferred = prefersBash ? locatedBash : locatedZsh
  const locatedOther = prefersBash ? locatedZsh : locatedBash

  // The preference-ordered fixed-location list is the base; located paths
  // are placed at the front (preferred family) and back (other family); a
  // supported, executable SHELL goes ahead of everything.
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

// ─────────────────────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved bash-lane shell configuration. */
export type ShellConfig = {
  provider: ShellProvider
}

/**
 * Discovery plus provider construction (which also kicks off snapshot
 * capture), memoized for the process lifetime. The promise itself is what
 * is cached, so a discovery failure is sticky: every later call in the same
 * process rejects the same way.
 */
export const getShellConfig = memoize(async (): Promise<ShellConfig> => {
  const shellPath = await findSuitableShell()
  const provider = await createBashShellProvider(shellPath)
  return { provider }
})

/**
 * The PowerShell provider, memoized separately from the cached PowerShell
 * path. Unavailability is cached as a sticky rejection too.
 */
export const getPsProvider = memoize(async (): Promise<ShellProvider> => {
  const powershellPath = await getCachedPowerShellPath()
  if (!powershellPath) {
    throw new Error('PowerShell is not available on this system')
  }
  return createPowerShellProvider(powershellPath)
})

/** Shell-type routing: exactly two lanes, resolved through a fixed table. */
const PROVIDER_TABLE: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => (await getShellConfig()).provider,
  powershell: () => getPsProvider(),
}

// ─────────────────────────────────────────────────────────────────────────────
// Working directory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the session working directory. Relative paths resolve against the
 * supplied base (or the injectable filesystem's current directory);
 * absolute paths are used as-is. The result is resolved through symlinks to
 * its physical path — matching what the shell reports — with no prior
 * existence check: the resolution IS the check, which closes the
 * time-of-check/time-of-use gap. A non-existent path throws with the
 * resolved path named; any other failure propagates unchanged.
 */
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
  // The session cwd owner performs NFC normalization on write.
  setCwdState(physical)
}

/** Does a directory still resolve on disk? (A command may have deleted it.) */
function directoryResolves(path: string): boolean {
  try {
    getFsImplementation().realpathSync(path)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

/** Default command timeout: 30 minutes. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** Options for one command execution. */
export type ExecOptions = {
  timeout?: number
  /** Progress callback: most recent lines, all lines, line count, byte count, output-incomplete flag. */
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
  /** Presence switches the run to pipe mode; receives every stdout chunk. */
  onStdout?: (chunk: string) => void
}

/**
 * Open the task-output file both streams share. Platform-specific contract:
 * on POSIX, write-only + create + append + no-follow — append makes each
 * write land at end-of-file atomically so the two streams never tear into
 * each other, and no-follow removes a symlink-swap window a sandboxed child
 * could otherwise use (treated as zero where the platform lacks the bit).
 * On Windows, the plain string mode `w`: an append-only handle there loses
 * write-data access, after which MSYS2/Cygwin children decide the handle is
 * read-only and throw their output away — and the mode is a string because
 * numeric flags can surface as EINVAL through the platform layer.
 */
function openTaskOutputFile(path: string): number {
  if (getPlatform() === 'windows') {
    return openSync(path, 'w')
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  return openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow)
}

/**
 * Run a command through the requested shell lane. Returns a running-command
 * handle without waiting for completion; command failures come back through
 * the handle, never as throws.
 */
export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options: ExecOptions = {},
): Promise<ShellCommand> {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS

  // The very first bash command in a session pays for discovery and
  // snapshot capture here.
  const provider = await PROVIDER_TABLE[shellType]()

  // Per-invocation artefacts are named by a 4-hex-digit id.
  const invocationId = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')

  // Computed unconditionally; handed to the provider only when sandboxing.
  // The directory-name component is per-user so two users on one host never
  // collide.
  const sandboxTmpDir = posixPath.join(
    process.env.MERCURY_TMPDIR || '/tmp',
    getMercuryTempDirName(),
  )
  const useSandbox = options.shouldUseSandbox === true

  const built = await provider.buildExecCommand(
    command,
    useSandbox
      ? { id: invocationId, sandboxTmpDir, useSandbox }
      : { id: invocationId, useSandbox },
  )

  // Working-directory resolution and recovery: a command may have deleted
  // its own working directory. The original boot directory is the fallback;
  // with both gone, nothing is spawned.
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

  // Deliberately after the cwd work: an aborted run with a deleted cwd
  // still reports the cwd failure.
  if (abortSignal.aborted) {
    return createAbortedCommand()
  }

  let finalCommand = built.commandString
  if (useSandbox) {
    // The sandbox wrapper hard-codes an inner `<shell> -c` invocation, which
    // would lose PowerShell's no-profile/non-interactive flags; for that
    // lane the provider pre-wraps the payload and /bin/sh carries it —
    // assumed present on every platform where sandboxing is supported.
    const innerShell = shellType === 'powershell' ? '/bin/sh' : provider.shellPath
    finalCommand = await SandboxManager.wrapWithSandbox(finalCommand, innerShell, abortSignal)
    try {
      // Owner-only and deliberately non-recursive; failure is not fatal.
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

  // The provider decides overrides from the ORIGINAL command string, not
  // the built or sandbox-wrapped one.
  const environmentOverrides = await provider.getEnvironmentOverrides(command)

  const taskId = generateTaskId('local_bash')
  const pipeMode = options.onStdout !== undefined
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, !pipeMode)
  await getFsImplementation().mkdir(getTaskOutputDir())

  // Merged child environment; later entries win. For the PowerShell lane
  // SHELL is assigned no value, which overrides the inherited copy — the
  // platform drops valueless keys, so the child sees no SHELL at all.
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
      // Termination is performed by the shell-command wrapper so the whole
      // process tree dies; the abort signal is deliberately not handed to
      // the spawn call.
      detached: provider.detached,
      windowsHide: true,
    })
    // Nothing ever writes the child's stdin: close it at once so a command
    // that reads standard input meets EOF immediately instead of blocking on
    // an open, silent pipe until the timeout fires (sweep #2, packet
    // 70 — both shell lanes; the banked safer-EOF variant, now ruled in).
    // A pipe stays the stdio kind so the child never inherits the terminal.
    try {
      child.stdin?.end()
    } catch {
      // A stdin that failed to open has nothing to close.
    }

    shellCommand = wrapSpawn(
      child,
      abortSignal,
      timeout,
      taskOutput,
      options.shouldAutoBackground ?? false,
    )

    if (outputFd !== undefined) {
      // This yield is the window in which a failed spawn raises its error
      // event; closing before the wrapper's listener exists would lose it.
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
      try {
        closeSync(outputFd)
      } catch (closeError) {
        // Individually guarded: a close failure must not fall into the
        // spawn-failure path and orphan a live child.
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
        // Nothing more to do with a descriptor that will not close.
      }
    }
    taskOutput.clear()
    logForDebugging(`spawn failed for shell command: ${errorMessage(spawnError)}`)
    // 126 is the conventional Unix "cannot execute" status.
    return createAbortedCommand(undefined, { code: 126, stderr: errorMessage(spawnError) })
  }

  // Completion work rides the result promise; the caller is never made to
  // wait on it.
  void shellCommand.result.then(result => {
    if (useSandbox) {
      try {
        // Before any await, on purpose: on Linux the sandbox leaves
        // zero-byte mount-point files in the working tree, and no awaiter
        // of the result may ever see the debris.
        SandboxManager.cleanupAfterCommand()
      } catch (cleanupError) {
        logForDebugging(`sandbox cleanup failed: ${errorMessage(cleanupError)}`)
      }
    }

    // The provider writes POSIX paths (it runs a POSIX shell); convert both
    // the file path and its contents to native form on Windows.
    const cwdFilePath =
      getPlatform() === 'windows' ? posixPathToWindowsPath(built.cwdFilePath) : built.cwdFilePath

    try {
      if (result && !options.preventCwdChanges && shellCommand.status !== 'backgrounded') {
        // Synchronous read, on purpose: whoever awaits the result must find
        // the new directory already in place the moment they resume.
        const record = readFileSync(cwdFilePath, 'utf8')
        // On Windows the record carries the shell's own Win32 spelling as a
        // second line and the engine refuses a drive-relative conversion
        // by name (FN-015 rank 45); elsewhere the single POSIX line is it.
        const recorded =
          getPlatform() === 'windows' ? nativeCwdFromShellRecord(record) : { path: record.trim() }
        if ('refused' in recorded) {
          // The shell moved, Mercury did not — said, never swallowed.
          logForDebugging(`bash cwd tracking: the session directory stays put — ${recorded.refused}`)
        } else if (recorded.path.normalize('NFC') !== cwdBefore.normalize('NFC')) {
          // The session cwd is stored NFC-normalized while the shell may
          // report NFD on macOS; without normalizing, every command under a
          // non-ASCII path would look like a directory change.
          setCwd(recorded.path, cwdBefore)
          invalidateSessionEnvCache()
          void onCwdChangedForHooks(cwdBefore, recorded.path)
        }
      }
    } catch (error) {
      // Swallowed on ANY failure, not just the read — but named in the debug
      // log: the command may have died before writing the file, and setCwd
      // throws when the recorded directory has since vanished. Either way
      // the session cwd is left alone.
      logForDebugging(`bash cwd tracking: the session directory stays put — ${errorMessage(error)}`)
    }

    void getFsImplementation()
      .unlink(cwdFilePath)
      .catch(() => {
        // Failure to unlink the tracking file is ignored.
      })
  })

  return shellCommand
}
