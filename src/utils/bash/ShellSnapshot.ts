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
import { getPlatform } from '../platform.js'
import { birthAfter, birthMark, endMsysGroupBeside, endProcessBornAfter, endProcessBornAt, endProcessTree, strikeProcessGroupNow, type BirthMark } from '../processGroup.js'
import { ripgrepCommand } from '../ripgrep.js'
import { sleep } from '../sleep.js'
import { loginExportsCarried, pathWithLoginEntries, subprocessEnv } from '../subprocessEnv.js'
import { SNAPSHOT_KEEPS_ALIASES, SNAPSHOT_OPTIONS, SNAPSHOT_READS_FUNCTIONS, argv0FunctionBody, noteLoginExports, noteLoginFiles, snapshotProfileOf, zshNamedBeforeBash, type LoginFilesAbsence, type ShellRecord } from '../shell/shellRecord.js'
import { windowsShellRoadActive, withOwnPrograms, withRoadPrograms, withShippedPrograms } from '../shell/windowsShellRoad.js'
import { msysSourceLine } from '../shell/msysArgv.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { quote } from './shellQuote.js'


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
  return new Promise(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const ownGroup = login && getPlatform() !== 'windows'
    const windowsLogin = login && getPlatform() === 'windows'
    const askedAt = Date.now()
    const child = spawn(file, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: ownGroup })
    const began = ownGroup ? birthMark(child.pid, askedAt) : null
    let treeEnded: Promise<unknown> = Promise.resolve()
    const end = (): void => {
      if (ownGroup) {
        strikeProcessGroupNow(child)
        return
      }
      if (windowsLogin) {
        if (child.exitCode === null && child.signalCode === null) treeEnded = endProcessTree(child, 'SIGKILL').catch((error: unknown) => logForDebugging(`the login run's tree was not ended: ${errorMessage(error)}`))
        return
      }
      try {
        child.kill(login ? 'SIGKILL' : undefined)
      } catch {
      }
    }
    const quit = (): void => {
      end()
      process.kill(process.pid, 'SIGQUIT')
    }
    if (ownGroup) {
      process.once('exit', end)
      process.once('SIGQUIT', quit)
    }
    const guard = setTimeout(() => {
      end()
      settle({ stdout: '', stderr: '', killed: true, overflowed: false })
    }, timeoutMs + SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS)
    const settle = (result: BoundedRun): void => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      process.removeListener('exit', end)
      process.removeListener('SIGQUIT', quit)
      if (ownGroup) end()
      const value = login ? { ...result, stdout: result.stdout.split('\0', 1)[0] ?? '', exported: exportedBy(stdout, env), began } : result
      if (windowsLogin) {
        if (result.killed || result.overflowed) resolve(value)
        void treeEnded.then(() => endGroupOfTheLoginRunOnWindows(file, stdout)).then(() => resolve(value))
        return
      }
      resolve(value)
    }
    const read = (stream: NodeJS.ReadableStream, keep: (chunk: string) => void): void => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        keep(chunk)
        if (stdout.length + stderr.length <= SNAPSHOT_OUTPUT_LIMIT) return
        end()
        settle({ stdout, stderr, killed: false, overflowed: true })
      })
    }
    read(child.stdout, chunk => {
      stdout += chunk
    })
    read(child.stderr, chunk => {
      stderr += chunk
    })
    child.once('error', error => settle({ stdout, stderr, killed: false, overflowed: false, unstarted: errorMessage(error) }))
    const ended = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle({ ...(code === null ? {} : { exitCode: code }), ...(signal === null ? {} : { signal }), stdout, stderr, killed: false, overflowed: false })
    if (!login) {
      child.once('close', ended)
      return
    }
    child.once('exit', (code, signal) => {
      end()
      const closed = new AbortController()
      child.once('close', () => closed.abort())
      void sleep(SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS, closed.signal).then(() => ended(code, signal))
    })
  })
}

const defaultSnapshotPathExecutor: SnapshotPathExecutor = (file, args, timeoutMs) =>
  runBounded(file, args, { ...withOwnPrograms(withShippedPrograms(subprocessEnv(), file), file) }, timeoutMs, false)

export async function resolveSnapshotPathValue(
  shellPath: string,
  options?: { platform?: string; exec?: SnapshotPathExecutor; probeTimeoutMs?: number },
): Promise<string> {
  const platform = options?.platform ?? getPlatform()
  const processPath = process.env.PATH ?? ''
  if (platform !== 'windows') return processPath
  if (!isPosixSnapshotShell(shellPath)) return processPath
  const exec = options?.exec ?? defaultSnapshotPathExecutor
  const timeoutMs = options?.probeTimeoutMs ?? SNAPSHOT_PATH_PROBE_TIMEOUT_MS
  try {
    const result = await exec(shellPath, ['-c', 'echo $PATH'], timeoutMs)
    const answer = (result.stdout ?? '').trim()
    if (result.exitCode === 0 && answer !== '' && answer !== '$PATH' && answer.includes('/')) {
      return answer
    }
    return processPath
  } catch {
    return processPath
  }
}


function buildArgv0Function(
  functionName: string,
  argv0Name: string,
  binaryPath: string,
  prependArgs: string[],
): string {
  const quotedBinary = quote([binaryPath])
  const prepend = prependArgs.length > 0 ? `${prependArgs.join(' ')} ` : ''
  if (getPlatform() === 'windows') {
    return `${functionName}() {
  ARGV0=${argv0Name} ${quotedBinary} ${prepend}"$@"
}`
  }
  return `${functionName}() {
${argv0FunctionBody(argv0Name, quotedBinary, prepend)}
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

type RipgrepShellIntegration = {
  type: 'alias' | 'function'
  snippet: string
}

function createRipgrepShellIntegration(): RipgrepShellIntegration {
  const rgCommand = ripgrepCommand()
  if (rgCommand.argv0 !== undefined) {
    return {
      type: 'function',
      snippet: buildArgv0Function('rg', rgCommand.argv0, rgCommand.rgPath, []),
    }
  }
  if (!rgCommand.rgPath.includes('/') && !rgCommand.rgPath.includes('\\')) {
    const target = quote([rgCommand.rgPath, ...rgCommand.rgArgs])
    return { type: 'alias', snippet: `alias rg=${quote([target])}` }
  }
  return { type: 'function', snippet: createResilientRgFunction(rgCommand) }
}

function getMercurySnapshotContent(pathValue: string): string {
  const rgIntegration = createRipgrepShellIntegration()

  const sections: string[] = []
  sections.push('# Mercury search tools')
  sections.push(`if ! (unalias rg 2>/dev/null; command -v rg >/dev/null 2>&1); then
${rgIntegration.snippet}
fi`)
  sections.push('# Mercury PATH')
  sections.push(`export PATH=${quote([pathValue])}`)
  return sections.join('\n')
}


const MERCURY_CONTENT_DELIMITER = '__MERCURY_SNAPSHOT_CONTENT__'
const PATH_LEFT_WITHOUT_PROGRAMS = 96

function buildCaptureScript(args: {
  snapshotFilePath: string
  configFilePath: string
  configExists: boolean
  definitions: boolean
  programsNeeded: boolean
  mercuryContent: string
}): string {
  const { snapshotFilePath, configFilePath, configExists, definitions, programsNeeded, mercuryContent } = args
  const lines: string[] = []

  lines.push(`SNAPSHOT_FILE=${quote([snapshotFilePath])}`)
  if (getPlatform() === 'windows') lines.push(`echo "${LOGIN_GROUP_MARK}=$$"`)

  if (configExists) {
    lines.push(`source ${quote([configFilePath])} < /dev/null`)
  } else {
    lines.push('# no user config file to source')
  }

  lines.push(PRINTS_EXPORTS)

  if (programsNeeded) lines.push(`for __mercury_program in awk sed head cat; do command -v "$__mercury_program" >/dev/null 2>&1 || exit ${PATH_LEFT_WITHOUT_PROGRAMS}; done`)
  lines.push('echo "# Mercury shell environment snapshot" >| "$SNAPSHOT_FILE"')
  lines.push(`echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"`)

  if (definitions) {
    lines.push('echo "# Functions" >> "$SNAPSHOT_FILE"')
    lines.push(SNAPSHOT_READS_FUNCTIONS)
    lines.push(`for __mercury_fn in $(declare -F | awk '{print $NF}'); do
  printf 'eval %q\\n' "$(declare -f -- "$__mercury_fn")" >> "$SNAPSHOT_FILE"
done`)
    lines.push('echo "} >/dev/null 2>&1" >> "$SNAPSHOT_FILE"')

    lines.push('echo "# Shell Options" >> "$SNAPSHOT_FILE"')
    lines.push(...SNAPSHOT_OPTIONS)

    lines.push('echo "# Aliases" >> "$SNAPSHOT_FILE"')
    const winptyFilter = getPlatform() === 'windows' ? ' | grep -v winpty' : ''
    lines.push(`( set +o posix 2>/dev/null; alias )${winptyFilter} | sed 's/^alias /alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
  } else {
    lines.push(SNAPSHOT_KEEPS_ALIASES)
  }

  lines.push(`cat >> "$SNAPSHOT_FILE" <<'${MERCURY_CONTENT_DELIMITER}'
${mercuryContent}
${MERCURY_CONTENT_DELIMITER}`)

  lines.push(`if [ ! -f "$SNAPSHOT_FILE" ]; then
  echo "snapshot file was not created" >&2
  exit 1
fi`)

  return lines.join('\n')
}


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
  const shellPath = shell.path
  const bashOfThisMachine = shell.origin !== 'engine' && getPlatform() !== 'windows'
  const nothing = (absence: LoginFilesAbsence): undefined => {
    if (bashOfThisMachine) noteLoginFiles(absence)
    return undefined
  }
  let scratch: string | undefined
  let readByZsh: Promise<void> | undefined
  try {
    const fs = getFsImplementation()
    const mercuryHome = getMercuryHome()
    let snapshotsDir = join(mercuryHome, 'shell-snapshots')
    if (options?.keptNowhere) {
      snapshotsDir = await mkdtemp(join(tmpdir(), 'mercury-login-run-'))
      scratch = snapshotsDir
    } else {
      const unmade = await fs.mkdir(snapshotsDir).then(() => null, (error: unknown) => errorMessage(error))
      if (unmade !== null) {
        const why = `the folder ${snapshotsDir} could not be made (${unmade}), so no login run was tried`
        logForDebugging(`shell snapshot capture skipped: ${why}`)
        logError(`shell snapshot creation failed: ${why}`)
        return nothing({ why, change: `Make ${mercuryHome} a folder Mercury can write in, or name another in MERCURY_CONFIG_DIR, ${THEN_RESTART}.` })
      }
    }

    const profile = snapshotProfileOf(shell.origin)
    const configFilePath = join(homedir(), profile.file)

    const snapshotFilePath = join(
      snapshotsDir,
      `snapshot-${profile.kind}-${Date.now()}-${randomSnapshotSuffix()}.sh`,
    )

    const configExists = await pathExists(configFilePath)
    const inherited = withRoadPrograms(subprocessEnv(), shell.origin, shellPath)
    const pathOfTheEngine = shell.origin === 'engine' ? Object.entries(inherited).find(([name]) => name.toUpperCase() === 'PATH')?.[1] : undefined
    const pathValue = pathOfTheEngine ?? (await resolveSnapshotPathValue(shellPath))
    const mercuryContent = getMercurySnapshotContent(pathValue)
    const script = buildCaptureScript({
      snapshotFilePath,
      configFilePath,
      configExists,
      definitions: bashOfThisMachine || configExists,
      programsNeeded: bashOfThisMachine,
      mercuryContent,
    })

    const captureEnv: NodeJS.ProcessEnv = {
      ...inherited,
      ...(bashOfThisMachine ? {} : { SHELL: shellPath }),
      GIT_EDITOR: 'true',
      MERCURY: '1',
    }

    const session = options?.keptNowhere !== true
    const zsh = zshOfTheUser()
    if (zsh !== null) readByZsh = exportsReadByZsh(zsh, session)
    const scriptFile = getPlatform() === 'windows' && shell.origin !== 'engine' ? `${snapshotFilePath}.login-run` : undefined
    if (scriptFile !== undefined) await writeFile(scriptFile, script)
    const handed = scriptFile === undefined ? script : msysSourceLine(windowsPathToPosixPath(scriptFile))
    const outcome = await runBounded(shellPath, shell.origin === 'engine' ? ['-l', '-c', handed] : ['-c', '-l', handed], captureEnv, SNAPSHOT_CAPTURE_BOUND_MS, true)
    if (scriptFile !== undefined) await rm(scriptFile, { force: true }).catch((error: unknown) => logForDebugging(`the login run's script file was not removed (${scriptFile}): ${errorMessage(error)}`))
    await readByZsh
    const carried = await carriedBy(outcome, session && zsh === null && !(shell.origin === 'engine' && getPlatform() === 'windows'))
    if (carried !== undefined) carriedFromBash.set(shellPath, carried)

    if (outcome.killed || outcome.exitCode !== 0) {
      const absence = loginRunLeftNothing(outcome)
      logForDebugging(
        [
          'shell snapshot capture failed',
          `  ${absence.why} (${shellPath})`,
          `  config file: ${configFilePath} (exists: ${configExists})`,
          `  cwd: ${getCwd()}`,
          `  mercury home: ${mercuryHome}`,
          '  script:',
          script,
          outcome.stdout.length > 0
            ? `  stdout (${outcome.stdout.length} chars):\n${outcome.stdout}`
            : '  stdout: none captured',
          outcome.stderr.length > 0
            ? `  stderr (${outcome.stderr.length} chars):\n${outcome.stderr}`
            : '  stderr: none captured',
        ].join('\n'),
      )
      logError(`shell snapshot creation failed: ${absence.why} (${shellPath})`)
      if (session && getPlatform() === 'windows') loginRunsThatFailed.add(shellPath)
      return nothing(absence)
    }

    try {
      const stats = await stat(snapshotFilePath)
      logForDebugging(`shell snapshot created at ${snapshotFilePath} (${stats.size} bytes)`)
    } catch {
      logForDebugging(`shell snapshot file missing after capture: ${snapshotFilePath} (${LOGIN_RUN_HANDED_OVER.why}; ${shellPath})`)
      try {
        const entries = await fs.readdir(snapshotsDir)
        logForDebugging(`snapshots directory ${snapshotsDir} holds ${entries.length} entries`)
      } catch {
        logForDebugging(`snapshots directory ${snapshotsDir} no longer exists`)
      }
      if (session && getPlatform() === 'windows') loginRunsThatFailed.add(shellPath)
      return nothing(LOGIN_RUN_HANDED_OVER)
    }

    if (bashOfThisMachine) noteLoginFiles(null)
    if (scratch !== undefined) return undefined
    const path = pathWithLoginEntries(pathValue, loginExports(shellPath))
    if (path !== pathValue) await appendFile(snapshotFilePath, `export PATH=${quote([path])}\n`)
    registerCleanup(async () => {
      try {
        await getFsImplementation().unlink(snapshotFilePath)
        logForDebugging(`removed shell snapshot ${snapshotFilePath}`)
      } catch (cleanupError) {
        logForDebugging(
          `failed to remove shell snapshot ${snapshotFilePath}: ${errorMessage(cleanupError)}`,
        )
      }
    })
    return snapshotFilePath
  } catch (unexpectedError) {
    const stack = unexpectedError instanceof Error ? unexpectedError.stack : undefined
    logForDebugging(
      `shell snapshot capture threw unexpectedly: ${errorMessage(unexpectedError)}${
        stack ? `\n${stack}` : ''
      }`,
    )
    logError(`shell snapshot creation failed: ${errorMessage(unexpectedError)}`)
    return nothing(loginRunLeftNothing({ stdout: '', stderr: '', killed: false, overflowed: false, unstarted: errorMessage(unexpectedError) }))
  } finally {
    await readByZsh
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => logForDebugging(`the login run's folder ${scratch} was not removed: ${errorMessage(error)}`))
    }
  }
}
