import { spawnOwnedShell, tellWhatTheShellGuardReads } from './shell/parentGuard.js'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { memoize } from 'lodash-es'
import { getOriginalCwd, setCwdState, subscribeCwdState } from '../bootstrap/state.js'
import { generateTaskId } from '../Task.js'
import { createAndSaveSnapshot, loginExports } from './bash/ShellSnapshot.js'
import { contextShellCwd, getCwd, getStartingCwd, setContextShellCwd, tellWhereACdLeftTheShell, tellWhereTheShellStands } from './cwd.js'
import { logForDebugging } from './debug.js'
import { diagnosticAsksFor, isReadOnlyDiagnostic } from './diagnosticReadOnly.js'
import { errorMessage, getErrnoCode, isENOENT } from './errors.js'
import { normalizePathForComparison } from './file.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { appendNoFollowFlags } from './platform/files.js'
import { nativeCwdFromRecordedShell, shellPathToNative } from './platform/paths.js'
import { posixExitSignalsCount } from './platform/processes.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { createBashShellProvider } from './shell/bashProvider.js'
import { createEngineCommandProvider, perCommandEngineBinary, resolveShellEngine, runEngineCommand, resolveEngineSessionCeiling } from './shell/engineSession.js'
import { getInitialSettings } from './settings/settings.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { createPowerShellProvider } from './shell/powershellProvider.js'
import type { FrameHandOver, ShellProvider, ShellType } from './shell/shellProvider.js'
import { fallbackEngineBinary, systemShellRecord } from './shell/shellRecord.js'
import { wrapSpawn, createAbortedCommand, createFailedCommand, type ExecResult, type ShellCommand } from './ShellCommand.js'
import { noteMsysGroupLeftBehind, noteShellOfThisProcess, tellProcessGroupTheShell, tellWhatProcessGroupEnds } from './processGroup.js'
import { toolShellEnv, subprocessEnv, withLoginExports } from './subprocessEnv.js'
import { scrubSessionEnvStamps } from '../substrate/envStamps.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { WINDOWS_STARTS_A_PROGRAM_IN, posixPathToWindowsPath } from './windowsPaths.js'
import { planWindowsBatchInvocation, runWindowsBatchCommand } from './shell/windowsBatchInvocation.js'
import { windowsShellRoadActive, withRoadPrograms } from './shell/windowsShellRoad.js'
import { passedOver } from './passedOver.js'
import { startImmediate } from './timers.js'

export const getShellConfig = memoize(async (): Promise<{ provider: ShellProvider }> => ({
  provider: await createBashShellProvider(await systemShellRecord()),
}))

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
  const path = await getCachedPowerShellPath()
  if (!path) throw new Error('PowerShell is not available on this system')
  return createPowerShellProvider(path)
})

const PROVIDER_TABLE: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => {
    const fallback = await fallbackEngineBinary()
    return fallback === null ? (await getShellConfig()).provider : createEngineCommandProvider(fallback)
  },
  powershell: getPsProvider,
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
  const invocationId = randomBytes(6).toString('hex')
  const built = await road.provider.buildExecCommand(command, { id: invocationId })
  const { env, scrubbed } = await commandEnvironment(road, 'bash', command, inheritSessionEnv)
  const native = (path: string): string => shellPathToNative(path)
  const handed = built.handOver?.(env)
  if (handed?.file !== undefined) writeFileSync(handed.file.path, handed.file.text)
  return {
    file: road.provider.shellPath,
    args: handed?.args ?? road.provider.getSpawnArgs(built.commandString),
    argsFor: line => road.provider.getSpawnArgs(line),
    env: road.provider.origin === undefined ? env : withRoadPrograms(env, road.provider.origin, road.provider.shellPath),
    scrubbed,
    leftBehind: [...[built.cwdFilePath, ...(built.pipelineStatusPath === undefined ? [] : [built.pipelineStatusPath]), ...(built.jobsPath === undefined ? [] : [built.jobsPath])].map(native), ...(handed?.file === undefined ? [] : [handed.file.path])],
  }
}

tellWhatProcessGroupEnds(line => logForDebugging(`shell jobs: ${line}`))
tellProcessGroupTheShell(() => subprocessEnv().SHELL)
tellWhatTheShellGuardReads(line => logForDebugging(`shell guard: ${line}`))

const ranUnderABashOfWindows = new WeakSet<ExecResult>()

export function signalsCountIn(result: ExecResult): boolean {
  return posixExitSignalsCount() || ranUnderABashOfWindows.has(result)
}

function noteServingShell(shellPath: string): void {
  try {
    noteShellOfThisProcess(shellPath)
  } catch (error) {
    logForDebugging(`shell jobs: the bash that serves was not recorded for whoever ends this process: ${errorMessage(error)}`)
  }
}

function dropOwnFile(path: string, what: string): void {
  void getFsImplementation()
    .unlink(path)
    .catch((error: unknown) => {
      if (!isENOENT(error)) logForDebugging(`${what} was not removed (${path}): ${errorMessage(error)}`)
    })
}

async function noteJobsLeftBehind(shellPath: string, group: number): Promise<void> {
  try {
    const left = await noteMsysGroupLeftBehind(shellPath, group)
    if (left.length > 0) logForDebugging(`shell jobs: a finished command left ${left.length} program(s) running (MSYS group ${group}, Windows pid ${left.join(', ')}); they end with this process`)
  } catch (error) {
    logForDebugging(`shell jobs: what a finished command left running was not read: ${errorMessage(error)}`)
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
  const target = isAbsolute(path) ? path : resolvePath(base ?? fs.cwd(), path)
  let real: string
  try {
    real = fs.realpathSync(target)
  } catch (error) {
    if (isENOENT(error)) throw new Error(`Path "${target}" does not exist`)
    throw error
  }
  setCwdState(real)
}

let shellCwd: string | null = null
let sessionCwdSeen: string | undefined
subscribeCwdState(sessionCwd => {
  if (sessionCwd === sessionCwdSeen) return
  sessionCwdSeen = sessionCwd
  shellCwd = null
})
tellWhereACdLeftTheShell(shellCwdLeftByCd)
tellWhereTheShellStands(getShellCwd)

function readShellCwd(): string | null {
  const own = contextShellCwd()
  return own === undefined ? shellCwd : own
}

function writeShellCwd(next: string | null): void {
  if (!setContextShellCwd(next)) shellCwd = next
}

export function getShellCwd(): string {
  const last = readShellCwd()
  return last !== null && probeDirectory(last).ok ? last : getCwd()
}

function shellCwdLeftByCd(): string | null {
  const directory = getShellCwd()
  return normalizePathForComparison(directory) === normalizePathForComparison(getCwd()) ? null : directory
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

function shellDirectoryIsNow(now: string, why: string): string {
  return `The shell's directory is now ${now}: ${why}.`
}

function whyTheShellLeft(folder: string, probe: { missing: boolean; error: unknown }): string {
  return probe.missing ? `${folder} no longer exists` : `${folder} could not be entered (${errorMessage(probe.error)})`
}

function startRefusal(folder: string, tracked: boolean, bashLeaves: boolean): string | null {
  if (getPlatform() !== 'windows' || folder.length <= WINDOWS_STARTS_A_PROGRAM_IN) return null
  return shellDirectoryStays(tracked ? folder : getShellCwd(), `${NO_PROGRAM_STARTS_PAST}, and ${tracked ? 'this one' : folder} has ${folder.length}, so the command was not started${tracked && bashLeaves ? '; cd to a shorter folder with the Bash tool' : ''}`)
}

function folderNoProgramStartsIn(path: string, base: string): string | null {
  if (getPlatform() !== 'windows') return null
  const physical = getFsImplementation().realpathSync(isAbsolute(path) ? path : resolvePath(base, path))
  return physical.length > WINDOWS_STARTS_A_PROGRAM_IN ? shellDirectoryStays(base, `${NO_PROGRAM_STARTS_PAST}, and ${physical} has ${physical.length}; name such a folder by its path`) : null
}

function probeDirectory(path: string): { ok: true } | { ok: false; missing: boolean; error: unknown } {
  try {
    getFsImplementation().realpathSync(path)
    return { ok: true }
  } catch (error) {
    return { ok: false, missing: isENOENT(error), error }
  }
}

function leaveKeptDirectoryThatFails(): string | null {
  const kept = readShellCwd()
  if (kept === null) return null
  const probe = probeDirectory(kept)
  if (probe.ok) return null
  writeShellCwd(null)
  const now = getCwd()
  logForDebugging(`shell directory: ${whyTheShellLeft(kept, probe)}; the shell is back in ${now}`)
  return shellDirectoryIsNow(now, whyTheShellLeft(kept, probe))
}

function tellInResult(result: ExecResult, shellType: ShellType, line: string): void {
  if (shellType === 'bash') result.stderr = result.stderr === '' ? line : `${result.stderr}\n${line}`
  else result.stdout = `${result.stdout}${result.stdout === '' || result.stdout.endsWith('\n') ? '' : '\n'}${line}\n`
}


const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

type ExecOptions = {
  backgroundIntent?: boolean
  cwd?: string
  inheritSessionEnv?: boolean
  onProgress?: (recentLines: string, allLines: string, numLines: number, numBytes: number, incomplete: boolean) => void
  onStdout?: (chunk: string) => void
  owner?: string
  preventCwdChanges?: boolean
  shouldAutoBackground?: boolean
  timeout?: number
}

function openTaskOutputFile(path: string): number {
  return openSync(path, appendNoFollowFlags('w'))
}

export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options: ExecOptions = {},
): Promise<ShellCommand> {
  const notes: string[] = []
  if (options.cwd === undefined) {
    const left = leaveKeptDirectoryThatFails()
    if (left !== null) notes.push(left)
  }
  const ran = await execOnARoad(command, abortSignal, shellType, options, notes)
  if (notes.length > 0) {
    void ran.result.then(result => {
      for (const note of notes) tellInResult(result, shellType, note)
    })
  }
  return ran
}

type ShellFrame = Awaited<ReturnType<ShellProvider['buildExecCommand']>>

type ThirdRoad = {
  road: SpawnRoad
  frame: ShellFrame
  handOver: FrameHandOver | undefined
  runFolder: string
  asked: string | undefined
  shellType: ShellType
  options: ExecOptions
}

async function execOnARoad(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options: ExecOptions,
  notes: string[],
): Promise<ShellCommand> {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS
  const asked = options.cwd === undefined ? undefined : resolveShellCwd(options.cwd)
  if (asked !== undefined) {
    const probe = probeDirectory(asked)
    if (!probe.ok) return askedFolderFails(asked, probe)
  }
  if (shellType === 'bash' && options.onStdout === undefined && options.backgroundIntent !== true && options.inheritSessionEnv !== true) {
    const engine = await engineRoad(command, abortSignal, options, timeout, asked)
    if (engine !== null) return engine
  }
  if (shellType === 'bash') {
    const batch = await batchRoad(command, abortSignal, options, timeout, asked)
    if (batch !== null) return batch
  }

  const road = await spawnRoad(shellType)
  const frame = await road.provider.buildExecCommand(command, { id: randomBytes(6).toString('hex') })
  const runFolder = runFolderFor(asked, notes)
  if (typeof runFolder !== 'string') return runFolder
  if (frame.handOver === undefined) {
    const refusal = startRefusal(runFolder, asked === undefined, shellType !== 'bash')
    if (refusal !== null) return createFailedCommand(refusal)
  }
  if (abortSignal.aborted) return createAbortedCommand()
  const spawnArgs = road.provider.getSpawnArgs(frame.commandString)
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), options.onProgress ?? null, options.onStdout === undefined)
  await getFsImplementation().mkdir(getTaskOutputDir())
  const { env, scrubbed } = await commandEnvironment(road, shellType, command, options.inheritSessionEnv === true)
  if (road.recordsBash) markFrameUnread(frame.cwdFilePath)
  const handOver = frame.handOver?.(env, runFolder)
  if (handOver !== undefined) noteServingShell(road.provider.shellPath)
  const run: ThirdRoad = { road, frame, handOver, runFolder, asked, shellType, options }
  return startShell(run, spawnArgs, env, scrubbed, taskOutput, abortSignal, timeout)
}

function askedFolderFails(folder: string, probe: { missing: boolean; error: unknown }): ShellCommand {
  return createFailedCommand(probe.missing ? `Path "${folder}" does not exist` : errorMessage(probe.error))
}

async function engineRoad(
  command: string,
  abortSignal: AbortSignal,
  options: ExecOptions,
  timeout: number,
  asked: string | undefined,
): Promise<ShellCommand | null> {
  const settings = getInitialSettings()
  const engine = resolveShellEngine(settings.shell?.engine)
  const binary = engine.engine === 'brush' ? engine.binaryPath : await fallbackEngineBinary()
  if (binary === null) return null
  if (abortSignal.aborted) return createAbortedCommand()
  return runEngineCommand(binary, command, {
    timeout,
    signal: abortSignal,
    onProgress: options.onProgress,
    owner: options.owner,
    sessionCeiling: resolveEngineSessionCeiling(settings.shell?.sessions),
    cwd: asked ?? getShellCwd(),
    requireCwd: asked !== undefined,
    onCwd: reported => followEngineCwd(reported, options.preventCwdChanges, asked),
  })
}

function followEngineCwd(reported: string, preventCwdChanges: boolean | undefined, asked: string | undefined): void {
  if (preventCwdChanges || asked !== undefined) return
  try {
    const current = getShellCwd()
    if (reported.normalize('NFC') === current.normalize('NFC')) return
    recordShellCwd(reported, current)
    invalidateSessionEnvCache()
  } catch (error) {
    logForDebugging(`engine cwd tracking: the shell directory stays put — ${errorMessage(error)}`)
  }
}

async function batchRoad(
  command: string,
  abortSignal: AbortSignal,
  options: ExecOptions,
  timeout: number,
  asked: string | undefined,
): Promise<ShellCommand | null> {
  if (getPlatform() !== 'windows' || abortSignal.aborted) return null
  if (resolveShellEngine(getInitialSettings().shell?.engine).engine !== 'system') return null
  const folder = asked ?? getShellCwd()
  if (!probeDirectory(folder).ok) return null
  const plan = await planWindowsBatchInvocation(command, { cwd: folder })
  if (plan.kind !== 'batch') return null
  const refusal = startRefusal(folder, asked === undefined, true)
  if (refusal !== null) return createFailedCommand(refusal)
  logForDebugging(`batch invocation through cmd.exe: ${plan.batchPath}`)
  return runWindowsBatchCommand(plan, abortSignal, {
    timeout,
    cwd: folder,
    shouldAutoBackground: options.shouldAutoBackground ?? false,
    inheritSessionEnv: options.inheritSessionEnv === true,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
  })
}

function runFolderFor(asked: string | undefined, notes: string[]): string | ShellCommand {
  const folder = asked ?? getShellCwd()
  const probe = probeDirectory(folder)
  if (probe.ok) return folder
  if (asked !== undefined) return askedFolderFails(asked, probe)
  const why = whyTheShellLeft(folder, probe)
  const original = getOriginalCwd()
  const back = probeDirectory(original)
  if (!back.ok) {
    return createFailedCommand(
      back.missing
        ? `The working directory ${why}, and the original startup directory is gone too. Restart Mercury from an existing directory.`
        : errorMessage(back.error),
    )
  }
  if (contextShellCwd() === undefined) setCwdState(original)
  writeShellCwd(null)
  logForDebugging(`working directory: ${why}; recovered to the original directory ${original}`)
  notes.push(shellDirectoryIsNow(original, why))
  return original
}

async function startShell(
  run: ThirdRoad,
  spawnArgs: string[],
  env: NodeJS.ProcessEnv,
  scrubbed: string[],
  taskOutput: TaskOutput,
  abortSignal: AbortSignal,
  timeout: number,
): Promise<ShellCommand> {
  const { road, handOver, options } = run
  const onStdout = options.onStdout
  let outputFd: number | undefined
  try {
    if (handOver?.file !== undefined) writeFileSync(handOver.file.path, handOver.file.text)
    if (onStdout === undefined) outputFd = openTaskOutputFile(taskOutput.path)
    const stdio: Array<'pipe' | number> = outputFd === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', outputFd, outputFd]
    const child = await spawnOwnedShell(road.provider.shellPath, handOver?.args ?? spawnArgs, {
      cwd: handOver?.startIn ?? run.runFolder,
      env: road.provider.origin === undefined ? env : withRoadPrograms(env, road.provider.origin, road.provider.shellPath),
      stdio,
      detached: road.provider.detached,
      windowsHide: true,
    })
    try {
      child.stdin?.end()
    } catch (error) {
      passedOver(error)
    }
    const shellCommand = wrapSpawn(child, abortSignal, timeout, taskOutput, road.engineBinary === null ? (options.shouldAutoBackground ?? false) : false)
    shellCommand.scrubbedSessionEnv = scrubbed
    if (outputFd !== undefined) {
      await new Promise<void>(resolveTick => startImmediate(resolveTick))
      const opened = outputFd
      outputFd = undefined
      try {
        closeSync(opened)
      } catch (error) {
        logForDebugging(`failed to close task output descriptor: ${errorMessage(error)}`)
      }
    }
    if (onStdout !== undefined) {
      child.stdout?.on('data', (chunk: string | Buffer) => onStdout(typeof chunk === 'string' ? chunk : chunk.toString()))
    }
    void shellCommand.result.then(result => afterTheCommand(run, result))
    return shellCommand
  } catch (error) {
    return failedStart(run, error, outputFd, taskOutput)
  }
}

async function failedStart(run: ThirdRoad, error: unknown, outputFd: number | undefined, taskOutput: TaskOutput): Promise<ShellCommand> {
  const { road, frame, handOver } = run
  if (outputFd !== undefined) {
    try {
      closeSync(outputFd)
    } catch (closeError) {
      passedOver(closeError)
    }
  }
  taskOutput.clear()
  if (handOver?.file !== undefined) dropOwnFile(handOver.file.path, "the file that carried the command's frame")
  if (road.recordsBash) void getFsImplementation().unlink(frame.cwdFilePath).catch(passedOver)
  logForDebugging(`spawn failed for shell command: ${errorMessage(error)}`)
  const code = getErrnoCode(error)
  if (road.recordsBash && code === 'ENOENT' && !existsSync(road.provider.shellPath)) {
    return createFailedCommand(await shellGoneWords(road.provider.shellPath))
  }
  if (code === 'ENAMETOOLONG' || code === 'E2BIG') {
    return createFailedCommand(
      `The shell command exceeds the platform's command-line limit (${code}). Put the command in a script file and run that file instead. ${errorMessage(error)}`,
    )
  }
  return createFailedCommand(errorMessage(error))
}

function afterTheCommand(run: ThirdRoad, result: ExecResult): void {
  const { road, frame, handOver } = run
  if (handOver !== undefined && road.provider.origin !== 'engine') ranUnderABashOfWindows.add(result)
  const cwdFile = shellPathToNative(frame.cwdFilePath)
  followShellFolder(run, result, cwdFile)
  if (frame.pipelineStatusPath !== undefined) readPipelineStatus(result, shellPathToNative(frame.pipelineStatusPath))
  if (frame.jobsPath !== undefined) readJobsGroup(road.provider.shellPath, result, frame.jobsPath)
  if (handOver?.file !== undefined) dropOwnFile(handOver.file.path, "the file that carried the command's frame")
  void getFsImplementation().unlink(cwdFile).catch(passedOver)
}

function followShellFolder(run: ThirdRoad, result: ExecResult, cwdFile: string): void {
  const tell = (line: string): void => tellInResult(result, run.shellType, line)
  let moving: string | undefined
  try {
    const text = readFileSync(cwdFile, 'utf8')
    if (run.road.recordsBash && text === FRAME_UNREAD) {
      if (!result.interrupted && result.backgroundTaskId === undefined) {
        result.stderr = result.stderr === '' ? SHELL_ENDED_UNREAD : `${result.stderr}\n${SHELL_ENDED_UNREAD}`
        if (result.code === 0) result.code = 126
      }
      return
    }
    if (run.options.preventCwdChanges || run.asked !== undefined || result.backgroundTaskId !== undefined) return
    const recorded = nativeCwdFromRecordedShell(text)
    const trimmed = text.trim()
    if (run.road.recordsBash && trimmed === '') {
      logForDebugging('bash cwd tracking: the shell directory stays put — the command left no directory')
    } else if ('refused' in recorded) {
      logForDebugging(`bash cwd tracking: the shell directory stays put — ${recorded.refused}`)
      if (trimmed !== '') tell(shellDirectoryStays(run.runFolder, `${trimmed.split(/\r?\n/)[0]} is a folder of the bash's own with no Windows path`))
    } else if (recorded.path.normalize('NFC') !== run.runFolder.normalize('NFC')) {
      moving = recorded.path
      const refusal = run.frame.handOver === undefined ? folderNoProgramStartsIn(recorded.path, run.runFolder) : null
      if (refusal !== null) {
        tell(refusal)
      } else {
        recordShellCwd(recorded.path, run.runFolder)
        invalidateSessionEnvCache()
      }
    }
  } catch (error) {
    logForDebugging(`bash cwd tracking: the shell directory stays put — ${errorMessage(error)}`)
    if (moving !== undefined && getPlatform() === 'windows') {
      tell(shellDirectoryStays(run.runFolder, `${moving} does not resolve (${errorMessage(error)})`))
    }
  }
}

function readPipelineStatus(result: ExecResult, file: string): void {
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (/^\d+(?:\s+\d+)+$/.test(text)) result.pipelineStatus = text.split(/\s+/).map(Number)
  } catch (error) {
    passedOver(error)
  }
  void getFsImplementation().unlink(file).catch(passedOver)
}

function readJobsGroup(shellPath: string, result: ExecResult, jobsPath: string): void {
  const file = posixPathToWindowsPath(jobsPath)
  let group = Number.NaN
  try {
    group = Number(readFileSync(file, 'utf8').trim())
  } catch (error) {
    if (!isENOENT(error)) logForDebugging(`shell jobs: the record of the command's group was not read (${file}): ${errorMessage(error)}`)
  }
  dropOwnFile(file, "shell jobs: the record of the command's group")
  if (Number.isSafeInteger(group) && result.backgroundTaskId === undefined) void noteJobsLeftBehind(shellPath, group)
}
