import { spawn } from 'node:child_process'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { onExit } from 'signal-exit'
import { scrubSessionEnvStamps } from '../../substrate/envStamps.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import {
  argv0EnvAssignmentBody,
  carriesBashLoginExports,
  isHostPosixBash,
  loginGroupMarkLine,
  loginRunGetsOwnProcessGroup,
  loginRunScriptFilePath,
  loginRunUsesProcessTreeCleanup,
  remembersFailedLoginRun,
  snapshotAliasPipelineFilter,
  snapshotPathNeedsShellProbe,
} from '../platform/loginShell.js'
import { birthAfter, birthMark, endMsysGroupBeside, endProcessBornAfter, endProcessBornAt, endProcessTree, strikeProcessGroupNow, type BirthMark } from '../processGroup.js'
import { ripgrepCommand } from '../ripgrep.js'
import { sleep } from '../sleep.js'
import { loginExportsCarried, pathWithLoginEntries, subprocessEnv } from '../subprocessEnv.js'
import { SNAPSHOT_KEEPS_ALIASES, SNAPSHOT_OPTIONS, SNAPSHOT_READS_BACK, SNAPSHOT_READS_BACK_ALIASES, SNAPSHOT_READS_FUNCTIONS, argv0FunctionBody, noteLoginExports, noteLoginFiles, snapshotProfileOf, zshNamedBeforeBash, type LoginFilesAbsence, type ShellRecord } from '../shell/shellRecord.js'
import { windowsShellRoadActive, withOwnPrograms, withRoadPrograms, withShippedPrograms } from '../shell/windowsShellRoad.js'
import { msysSourceLine } from '../shell/msysArgv.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { quote } from './shellQuote.js'
import { passedOver } from '../passedOver.js'
import { hostEnv } from '../hostEnv.js'
import { startTimeout, stopTimeout } from '../timers.js'
import { notBuilt } from '../../pi/holes.js'


type VersionedPathParts = {
  versionsRoot: string
  version: string
  suffix: string
}

export function deriveVersionedPathParts(path: string): VersionedPathParts | null {
  const match = /^(.*[/\\]|)(versions)[/\\]([^/\\]+)([/\\].+)$/.exec(path)
  if (!match) return null
  return {
    versionsRoot: `${match[1]}${match[2]}`,
    version: match[3] as string,
    suffix: match[4] as string,
  }
}

const POSIX_SHELL_BASENAMES: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh', 'dash'])

export function isPosixSnapshotShell(shellPath: string): boolean {
  const segments = shellPath.split(/[/\\]/)
  const basename = (segments[segments.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '')
  return POSIX_SHELL_BASENAMES.has(basename)
}

type SnapshotPathExecutor = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ exitCode?: number; stdout?: string }>

const SNAPSHOT_PATH_PROBE_TIMEOUT_MS = 10_000
const SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS = 250
const SNAPSHOT_CAPTURE_BOUND_MS = 10_000

const SNAPSHOT_OUTPUT_LIMIT = 1024 * 1024

type BoundedRun = { exitCode?: number; signal?: string; stdout: string; stderr: string; killed: boolean; overflowed: boolean; unstarted?: string; exported?: NodeJS.ProcessEnv | null; began?: BirthMark | null }

const LOGIN_EXPORTS_MARK = '__MERCURY_LOGIN_EXPORTS__'
const PRINTS_EXPORTS = `printf '\\0%s\\0' ${LOGIN_EXPORTS_MARK}; env -0; printf '%s\\0' ${LOGIN_EXPORTS_MARK}`
const ZSH_PRINTS_EXPORTS = `'builtin' 'printf' '\\0%s\\0' '${LOGIN_EXPORTS_MARK}'; '/usr/bin/env' '-0'; 'builtin' 'printf' '%s\\0' '${LOGIN_EXPORTS_MARK}'; 'builtin' 'unsetopt' 'rcs'`

function exportedBy(said: string, started: NodeJS.ProcessEnv): NodeJS.ProcessEnv | null {
  const parts = said.split('\0')
  const from = parts.indexOf(LOGIN_EXPORTS_MARK)
  const to = parts.indexOf(LOGIN_EXPORTS_MARK, from + 1)
  if (from === -1 || to === -1) return null
  const exported: NodeJS.ProcessEnv = {}
  for (const entry of parts.slice(from + 1, to)) {
    const at = entry.indexOf('=')
    if (at > 0 && started[entry.slice(0, at)] !== entry.slice(at + 1)) exported[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return exported
}

const agentsOfTheSession = new Set<number>()

const LOGIN_GROUP_MARK = '__MERCURY_LOGIN_GROUP__'
const LOGIN_GROUP_LINE = new RegExp(`${LOGIN_GROUP_MARK}=(\\d+)\\n`)

async function endGroupOfTheLoginRunOnWindows(shellPath: string, said: string): Promise<void> {
  const group = Number(LOGIN_GROUP_LINE.exec(said)?.[1])
  if (!Number.isSafeInteger(group) || group <= 1) return
  try {
    const ended = await endMsysGroupBeside(shellPath, group)
    if (ended.length > 0) logForDebugging(`the login run ended ${ended.length} process(es) its files left in its group: ${ended.join(', ')}`)
  } catch (error) {
    logForDebugging(`the processes the login files left were not ended: ${errorMessage(error)}`)
  }
}

async function settleAgentOfTheLoginFiles(exported: string | undefined, began: BirthMark | null, reached: boolean): Promise<void> {
  const pid = Number(exported)
  if (exported === undefined || agentsOfTheSession.has(pid)) return
  try {
    if (!reached) {
      if (await endProcessBornAfter(pid, began)) logForDebugging(`the login run ended the ssh-agent its files started (pid ${exported})`)
      return
    }
    const born = await birthAfter(pid, began)
    if (born === null) return
    agentsOfTheSession.add(pid)
    onExit(() => {
      try {
        endProcessBornAt(pid, born)
      } catch (error) {
        logForDebugging(`the ssh-agent the login files started was not ended at exit: ${errorMessage(error)}`)
      }
    })
    logForDebugging(`the ssh-agent the login files started (pid ${exported}) lives for this session and ends with it`)
  } catch (error) {
    logForDebugging(`the ssh-agent the login files started was not ended: ${errorMessage(error)}`)
  }
}

async function carriedBy(run: BoundedRun, supplies: boolean): Promise<NodeJS.ProcessEnv | undefined> {
  const exported = supplies && !run.killed && run.exitCode === 0 ? (run.exported ?? null) : null
  const reached = exported !== null && exported.SSH_AUTH_SOCK !== undefined && subprocessEnv().SSH_AUTH_SOCK === undefined
  await settleAgentOfTheLoginFiles(run.exported?.SSH_AGENT_PID, run.began ?? null, reached)
  if (exported === null) return undefined
  const carried = scrubSessionEnvStamps(loginExportsCarried(exported)).env
  if (!reached) delete carried.SSH_AGENT_PID
  return carried
}

function runBounded(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  login: boolean,
): Promise<BoundedRun> {
  return notBuilt('src/utils/bash/ShellSnapshot.ts:147')
}

const defaultSnapshotPathExecutor: SnapshotPathExecutor = (file, args, timeoutMs) =>
  runBounded(file, args, { ...withOwnPrograms(withShippedPrograms(subprocessEnv(), file), file) }, timeoutMs, false)

export async function resolveSnapshotPathValue(
  shellPath: string,
  options?: { platform?: string; exec?: SnapshotPathExecutor; probeTimeoutMs?: number },
): Promise<string> {
  return notBuilt('src/utils/bash/ShellSnapshot.ts:240')
}


function buildArgv0Function(
  functionName: string,
  argv0Name: string,
  binaryPath: string,
  prependArgs: string[],
): string {
  const quotedBinary = quote([binaryPath])
  const prepend = prependArgs.length > 0 ? `${prependArgs.join(' ')} ` : ''
  const body = argv0EnvAssignmentBody(argv0Name, quotedBinary, prepend) ?? argv0FunctionBody(argv0Name, quotedBinary, prepend)
  return `${functionName}() {
${body}
}`
}

function createResilientRgFunction(rgCommand: { rgPath: string; rgArgs: string[] }): string {
  const quotedPath = quote([rgCommand.rgPath])
  const defaults = rgCommand.rgArgs.map(arg => quote([arg])).join(' ')
  const prepend = defaults.length > 0 ? `${defaults} ` : ''
  const managed = deriveVersionedPathParts(rgCommand.rgPath)
  const unavailableMessage =
    'Mercury vendored ripgrep unavailable (its version directory may have been pruned by an update) and no system rg is on PATH'

  if (managed === null) {
    return `rg() {
  if [ -x ${quotedPath} ]; then
    ${quotedPath} ${prepend}"$@"
  else
    if command -v rg >/dev/null 2>&1; then command rg ${prepend}"$@"
    else
      echo "${unavailableMessage}" >&2
      return 127
    fi
  fi
}`
  }

  const quotedVersionsRoot = quote([managed.versionsRoot])
  const quotedPointer = quote([`${managed.versionsRoot}/current.txt`])
  const quotedSuffix = quote([managed.suffix])
  const currentCandidate = `${quotedVersionsRoot}/"$__mercury_rg_cur"${quotedSuffix}`
  return `rg() {
  if [ -x ${quotedPath} ]; then
    ${quotedPath} ${prepend}"$@"
  else
    __mercury_rg_cur=$(cat ${quotedPointer} 2>/dev/null)
    if [ -n "$__mercury_rg_cur" ] && [ -x ${currentCandidate} ]; then
      ${currentCandidate} ${prepend}"$@"
    elif command -v rg >/dev/null 2>&1; then command rg ${prepend}"$@"
    else
      echo "${unavailableMessage}" >&2
      return 127
    fi
  fi
}`
}


const MERCURY_CONTENT_DELIMITER = '__MERCURY_SNAPSHOT_CONTENT__'
const PATH_LEFT_WITHOUT_PROGRAMS = 96


const LOGIN_FILES = 'the files bash reads at login (~/.bash_profile, ~/.bash_login or ~/.profile, and ~/.bashrc)'
const INTERACTIVE_ONLY = 'only in an interactive shell (inside `case $- in *i*) … ;; esac`)'
const THEN_RESTART = 'then restart Mercury'

type LoginFilesRead = { files: string; only: string; asked: string; other: string }

const BASH_READS: LoginFilesRead = { files: LOGIN_FILES, only: INTERACTIVE_ONLY, asked: '`bash -l -c true`', other: '`exec zsh -l`' }

function zshReads(dotDir: string | undefined = subprocessEnv().ZDOTDIR): LoginFilesRead {
  const home = homedir()
  const at = dotDir === undefined || dotDir === '' ? '~' : (dotDir === home || dotDir.startsWith(`${home}/`) ? `~${dotDir.slice(home.length)}` : dotDir).replace(/\/+$/, '')
  return {
    files: `the files zsh reads at login (${at}/.zshenv, ${at}/.zprofile, ${at}/.zshrc and ${at}/.zlogin)`,
    only: 'only where a terminal is attached (inside `if [[ -t 0 ]]; then … fi`)',
    asked: '`zsh -l -i -c true`',
    other: '`exec fish -l`',
  }
}

function loginRunLeftNothing(outcome: BoundedRun, read: LoginFilesRead = BASH_READS): LoginFilesAbsence {
  if (outcome.killed) {
    return {
      why: `the login run did not end within ${SNAPSHOT_CAPTURE_BOUND_MS / 1000} s and was killed: a login file waits or runs long`,
      change: `Find what waits in ${read.files} (a question, a read from the terminal, a command that needs the network) and run it ${read.only}, ${THEN_RESTART}.`,
    }
  }
  if (outcome.overflowed) {
    return {
      why: `the login run printed more than ${SNAPSHOT_OUTPUT_LIMIT / (1024 * 1024)} MiB and was ended: a login file prints at length`,
      change: `Find what prints in ${read.files} and print it ${read.only}, ${THEN_RESTART}.`,
    }
  }
  if (outcome.unstarted !== undefined) {
    return { why: `the login run could not be started: ${outcome.unstarted}`, change: `Restart Mercury; if this comes back, the message names what keeps the shell from starting.` }
  }
  if (outcome.exitCode === undefined) {
    return { why: `the login run was ended by ${outcome.signal ?? 'a signal'}`, change: `Restart Mercury; if this comes back, run ${read.asked} in a terminal to see which of ${read.files} ends the shell.` }
  }
  if (outcome.exitCode === PATH_LEFT_WITHOUT_PROGRAMS && read === BASH_READS) {
    return {
      why: 'the login files leave PATH without awk, sed, head or cat, which the login run needs to carry anything',
      change: `Keep /usr/bin and /bin on PATH in ${LOGIN_FILES}, ${THEN_RESTART}.`,
    }
  }
  return {
    why: `the login run ended with exit ${String(outcome.exitCode)}`,
    change: `Find the line in ${read.files} that ends the shell (an \`exit\`, or a command that fails under \`set -e\`) and run it ${read.only}, ${THEN_RESTART}.`,
  }
}

function loginRunHandedOver(read: LoginFilesRead): LoginFilesAbsence {
  return {
    why: 'the login run ended before it carried anything: a login file ended the shell or handed it to another program',
    change: `Find the line in ${read.files} that ends the shell or starts another one (${read.other}) and run it ${read.only}, so that the rest of the file is carried, ${THEN_RESTART}.`,
  }
}

const LOGIN_RUN_HANDED_OVER = loginRunHandedOver(BASH_READS)

function zshOfTheUser(): string | null {
  return windowsShellRoadActive() ? null : zshNamedBeforeBash([subprocessEnv().SHELL, accountShell()])
}

function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined
  } catch (error) {
    logForDebugging(`the account's shell was not read: ${errorMessage(error)}`)
    return undefined
  }
}

let carriedFromZsh: NodeJS.ProcessEnv | undefined
const carriedFromBash = new Map<string, NodeJS.ProcessEnv>()
const loginRunsThatFailed = new Set<string>()

export function loginRunFailed(shellPath: string): boolean {
  return loginRunsThatFailed.has(shellPath)
}

export function loginExports(shellPath: string): NodeJS.ProcessEnv | undefined {
  return carriedFromZsh ?? carriedFromBash.get(shellPath)
}

const exportsReadByZsh = memoize(async (zsh: string, session: boolean): Promise<void> => {
  try {
    const run = await runBounded(zsh, ['-l', '-i', '-c', ZSH_PRINTS_EXPORTS], { ...subprocessEnv(), GIT_EDITOR: 'true', MERCURY: '1', SHELL_SESSIONS_DISABLE: '1' }, SNAPSHOT_CAPTURE_BOUND_MS, true)
    const carried = await carriedBy(run, session)
    if (session) carriedFromZsh = carried
    const absence = run.killed || run.exitCode !== 0 ? loginRunLeftNothing(run, zshReads()) : (run.exported ?? null) === null ? loginRunHandedOver(zshReads()) : null
    noteLoginExports(absence)
    if (absence === null) return
    logForDebugging(`the zsh login files carry nothing: ${absence.why} (${zsh})${run.stderr.length > 0 ? `\n  stderr (${run.stderr.length} chars):\n${run.stderr}` : ''}`)
    logError(`the zsh login files were not read: ${absence.why} (${zsh})`)
  } catch (error) {
    noteLoginExports(loginRunLeftNothing({ stdout: '', stderr: '', killed: false, overflowed: false, unstarted: errorMessage(error) }, zshReads()))
    logError(`the zsh login files were not read: ${errorMessage(error)} (${zsh})`)
  }
}, (zsh: string, session: boolean) => `${session ? 'session' : 'asked'} ${zsh}`)

function randomSnapshotSuffix(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return suffix
}

export async function createAndSaveSnapshot(
  shell: Pick<ShellRecord, 'path' | 'origin'>,
  options?: { keptNowhere?: boolean },
): Promise<string | undefined> {
  return notBuilt('src/utils/bash/ShellSnapshot.ts:528')
}
