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
import { errorMessage, isENOENT } from './errors.js'
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
import type { ShellProvider, ShellType } from './shell/shellProvider.js'
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
import { notBuilt } from '../pi/holes.js'

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
  options?: ExecOptions,
): Promise<ShellCommand> {
  return notBuilt('src/utils/Shell.ts:318')
}

async function execOnARoad(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options: ExecOptions,
  notes: string[],
): Promise<ShellCommand> {
  return notBuilt('src/utils/Shell.ts:338')
}
