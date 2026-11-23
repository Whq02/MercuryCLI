import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from '../logs/debugLog.js'
import { errorMessage } from '../errors/errors.js'
import { logError } from '../logs/errorLog.js'
import { endProcessTree, strikeProcessGroupNow } from '../processes/processGroup.js'
import { getInitialSettings } from '../settings/settings.js'
import { withDeadline } from '../async/deadline.js'
import { subprocessEnv } from '../processes/subprocessEnv.js'
import { which } from '../processes/which.js'
import { bashPackProgramsDir, resolveBashPackDir, type BashPackResolution } from './bashPack.js'
import { resolveBrushPackDir } from './brushPack.js'
import { shellEngineArmWords, type ShellEngineArm } from './shellEngineArm.js'
import { NO_SHELL_WAYS_OUT, PIN_WAYS_OUT, bashToolAvailable, describeWindowsShellRoad, engineMayServe, pinPassedOver, settleWindowsShell, shellFollowsTheRecord, shippedWindowsBash, windowsBashCandidates, windowsShellRoadActive, withoutShellStartFiles } from './windowsShellRoad.js'
import { hostEnv } from '../environment/hostEnv.js'
import { childGetsOwnProcessGroup } from '../host-os/processes.js'

export type ShellDialect = 'bash'
export type ShellOrigin = 'shipped' | 'system' | 'engine'

export type ShellRecord = {
  path: string
  dialect: ShellDialect
  version: string
  origin: ShellOrigin
}

const SHELL_FALLBACK_DIRECTORIES = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
const START_PROBE_TIMEOUT_MS = 5_000

const NO_SHELL_MESSAGE =
  'No shell found. Mercury runs commands in the bash it ships, then in the system bash, then in its bundled engine, and none of the three starts here; reinstall Mercury or install bash, then restart Mercury.'

const NO_WINDOWS_SHELL_MESSAGE =
  'No shell found. On Windows Mercury runs commands in a bash 5 that is installed (Git for Windows ships one), then in the bash it ships, then in its bundled engine, and none of the three starts here; install Git for Windows, set MERCURY_GIT_BASH_PATH to a bash.exe, or reinstall Mercury, then restart Mercury.'

const BASH_VERSION_SHAPE = /^\d+\.\d+/
const VERSION_ANSWER_LIMIT = 1024 * 1024

let askedNow: string | null = null
const whyNoAnswer = new Map<string, string>()
const whyUnfit = new Map<string, string>()

const VERSION_ASKED = 'printf %s $BASH_VERSION'

export function windowsShellQuestion(temp: string): { text: string; drive: string | null } {
  const drive = /^([A-Za-z]):[\\/]/.exec(temp)?.[1] ?? null
  return { text: drive === null ? VERSION_ASKED : `${VERSION_ASKED}; cd ${drive}:/ && printf :%s $PWD; :`, drive }
}

export function windowsShellAnswer(said: string, drive: string | null): { version: string; unfit?: string } {
  const last = (said.trim().split(/\r?\n/).pop() ?? '').trim()
  const cut = drive === null ? -1 : last.indexOf(':/')
  if (drive === null || cut < 0) return { version: last }
  const reads = last.slice(cut + 1)
  const wanted = `/${drive.toLowerCase()}`
  return { version: last.slice(0, cut), ...(reads.toLowerCase() === wanted ? {} : { unfit: `its runtime reads drive ${drive.toUpperCase()} as ${reads}, where Mercury writes ${wanted}` }) }
}

function questionEnvironment(): NodeJS.ProcessEnv {
  const env = withoutShellStartFiles({ ...subprocessEnv() })
  for (const name of Object.keys(env)) if (name.startsWith('BASH_FUNC_')) delete env[name]
  return env
}

export function startedBashVersion(path: string, limitMs: number = START_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const ownGroup = childGetsOwnProcessGroup()
      askedNow = path
      const question = process.platform === 'win32' ? windowsShellQuestion(tmpdir()) : { text: 'printf %s "$BASH_VERSION"', drive: null }
      whyUnfit.delete(path)
      const asked = spawn(path, ['--norc', '--noprofile', '-c', question.text], { windowsHide: true, detached: ownGroup, stdio: ['ignore', 'pipe', 'ignore'], env: questionEnvironment() })
      let said = ''
      let open = true
      const end = (): void => {
        if (ownGroup) strikeProcessGroupNow(asked)
        else void endProcessTree(asked, 'SIGKILL')
      }
      const endWithThisProcess = (): void => {
        if (ownGroup) strikeProcessGroupNow(asked)
        else asked.kill()
      }
      const answer = (version: string | null, why: string): void => {
        if (!open) return
        open = false
        if (askedNow === path) askedNow = null
        if (version === null) whyNoAnswer.set(path, why)
        process.removeListener('exit', endWithThisProcess)
        resolve(version)
      }
      const unanswered = (why: string): void => {
        if (!open) return
        end()
        answer(null, why)
      }
      process.once('exit', endWithThisProcess)
      asked.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        said += chunk
        if (said.length > VERSION_ANSWER_LIMIT) unanswered('it printed more than 1 MiB')
      })
      asked.once('error', error => {
        logForDebugging(`shell record: ${path} cannot be started — ${errorMessage(error)}`)
        answer(null, `it could not be started (${errorMessage(error)})`)
      })
      asked.once('close', code => {
        const { version, unfit } = windowsShellAnswer(said, question.drive)
        const answered = code === 0 && BASH_VERSION_SHAPE.test(version)
        if (answered && unfit !== undefined) whyUnfit.set(path, unfit)
        answer(answered && unfit === undefined ? version : null, answered && unfit !== undefined ? unfit : code === 0 ? 'it printed no bash version' : code === null ? 'it was ended by a signal' : `it ended with exit ${code}`)
      })
      AbortSignal.timeout(limitMs).addEventListener('abort', () => unanswered(`it gave no answer within ${limitMs / 1000} s`), { once: true })
    } catch (error) {
      logForDebugging(`shell record: ${path} cannot be started — ${errorMessage(error)}`)
      whyNoAnswer.set(path, `it could not be started (${errorMessage(error)})`)
      resolve(null)
    }
  })
}

export function zshNamedBeforeBash(shells: ReadonlyArray<string | undefined>): string | null {
  for (const shell of shells) {
    const name = basename(shell ?? '')
    if (name === 'bash') return null
    if (shell !== undefined && name === 'zsh' && existsSync(shell)) return shell
  }
  return null
}

async function systemBashCandidates(): Promise<string[]> {
  const shell = hostEnv().SHELL ?? ''
  const located = await which('bash')
  const candidates = [
    ...(basename(shell) === 'bash' ? [shell] : []),
    ...(located ? [located] : []),
    ...SHELL_FALLBACK_DIRECTORIES.map(directory => join(directory, 'bash')),
  ]
  return [...new Set(candidates)]
}

function shippedBash(): BashPackResolution {
  try {
    return resolveBashPackDir()
  } catch (error) {
    logForDebugging(`shell record: the shipped bash's record cannot be read — ${errorMessage(error)}`)
    return { state: 'unavailable', note: `its record cannot be read (${errorMessage(error)})` }
  }
}

export function shippedBashOnDisk(): { path: string; programsDir: string | null } | null {
  const pack = shippedBash()
  return pack.state === 'ok' ? { path: pack.binaryPath, programsDir: bashPackProgramsDir(pack.dir, pack.manifest) } : null
}

const passedOver: string[] = []
let noneStarts = false

function passOver(line: string): void {
  passedOver.push(line)
  logForDebugging(`shell record: ${line}`)
}

export function noSystemShellStarts(): boolean {
  return noneStarts
}

async function posixSystemRecord(): Promise<ShellRecord> {
  const pack = shippedBash()
  if (pack.state === 'ok') {
    const version = await startedBashVersion(pack.binaryPath)
    if (version !== null) return { path: pack.binaryPath, dialect: 'bash', version, origin: 'shipped' }
    passOver(`the bash Mercury ships, ${pack.binaryPath}, does not start`)
  } else {
    passOver(`this install carries no bash of its own: ${pack.note}`)
  }
  const found = (await systemBashCandidates()).filter(candidate => existsSync(candidate))
  for (const candidate of found) {
    const version = await startedBashVersion(candidate)
    if (version !== null) return { path: candidate, dialect: 'bash', version, origin: 'system' }
    passOver(`${candidate} does not start`)
  }
  if (found.length === 0) passOver(`no bash is on PATH or in ${SHELL_FALLBACK_DIRECTORIES.join(', ')}`)
  const engine = resolveBrushPackDir()
  if (engine.state === 'ok') {
    logForDebugging(`shell record: no bash starts on this machine; the bundled engine at ${engine.binaryPath} serves`)
    return { path: engine.binaryPath, dialect: 'bash', version: engine.manifest.version, origin: 'engine' }
  }
  passOver(`the bundled engine is unavailable: ${engine.note}`)
  noneStarts = true
  logError(NO_SHELL_MESSAGE)
  throw new Error(NO_SHELL_MESSAGE)
}

async function windowsSystemRecord(): Promise<ShellRecord> {
  const candidates = windowsBashCandidates()
  const choice = await settleWindowsShell({
    pinned: candidates.pinned,
    installed: candidates.installed,
    shipped: () => {
      const shipped = shippedWindowsBash()
      return shipped === null ? { absent: shippedBashNote() } : { path: shipped.path }
    },
    engine: () => {
      const engine = resolveBrushPackDir()
      return engine.state === 'ok' ? { path: engine.binaryPath, version: engine.manifest.version } : { absent: engine.note }
    },
    engineAllowed: engineMayServe(),
    start: startedBashVersion,
    why: path => whyNoAnswer.get(path),
    unfit: path => whyUnfit.get(path),
    passed: passedOver,
  })
  for (const line of choice.passed) logForDebugging(`shell record: ${line}`)
  noneStarts = choice.origin === 'none'
  shellFollowsTheRecord(choice.origin === 'none' ? null : choice.path)
  if (choice.origin === 'none') {
    logError(NO_WINDOWS_SHELL_MESSAGE)
    throw new Error(NO_WINDOWS_SHELL_MESSAGE)
  }
  logForDebugging(`shell record: ${choice.origin} at ${choice.path} serves the Windows road`)
  return { path: choice.path, dialect: 'bash', version: choice.version, origin: choice.origin }
}

let settledSystemRecord: ShellRecord | null = null

export function systemShellAt(path: string): ShellRecord {
  return { path, dialect: 'bash', version: '', origin: 'system' }
}

export const systemShellRecord = memoize(async (): Promise<ShellRecord> => {
  const record = windowsShellRoadActive() ? await windowsSystemRecord() : await posixSystemRecord()
  settledSystemRecord = record
  return record
})

export function settledSystemShell(): ShellRecord | null {
  return settledSystemRecord
}

export async function fallbackEngineBinary(): Promise<string | null> {
  const record = await systemShellRecord()
  return record.origin === 'engine' ? record.path : null
}

function armedEngine(): { record: ShellRecord; arm: ShellEngineArm } | null {
  const { resolveShellEngine } = require('./engineSession.js') as typeof import('./engineSession.js')
  const engine = resolveShellEngine(getInitialSettings().shell?.engine)
  return engine.engine === 'brush' ? { record: { path: engine.binaryPath, dialect: 'bash', version: engine.version, origin: 'engine' }, arm: engine.arm } : null
}

function armedEngineRecord(): ShellRecord | null {
  return armedEngine()?.record ?? null
}

export async function shellRecord(): Promise<ShellRecord> {
  return armedEngineRecord() ?? systemShellRecord()
}

export function shellRecordNow(): ShellRecord | null {
  return armedEngineRecord() ?? settledSystemRecord
}

export function completionDialect(): ShellDialect | null {
  return bashToolAvailable() ? 'bash' : null
}

export function profileShellWords(record: ShellRecord | null): string {
  return record?.dialect ?? 'bash'
}

export const OLD_BASH_SENTENCE =
  "on this bash a here-document inside $( ) breaks when its text holds an unpaired quote, backquote or parenthesis or a line ending in a backslash, so give such text to the command on standard input instead (git commit -F - <<'EOF')"

export const WINDOWS_SHELL_SENTENCE = 'use Unix shell syntax, not Windows (for example /dev/null rather than NUL, and forward slashes in paths)'

export function shellRecordWords(record: ShellRecord): string {
  if (record.origin === 'engine') return `brush ${record.version} (bash-compatible)`
  const number = /^\d+(?:\.\d+)*/.exec(record.version)?.[0]
  if (number === undefined) return 'bash'
  return Number(number.split('.')[0]) < 4 ? `bash ${number} — ${OLD_BASH_SENTENCE}` : `bash ${number}`
}

async function shellRecordIfAny(): Promise<ShellRecord | null> {
  try {
    return await shellRecord()
  } catch (error) {
    logForDebugging(`shell record: no shell to name — ${errorMessage(error)}`)
    return null
  }
}

export async function settleShellRecord(): Promise<void> {
  await shellRecordIfAny()
}

export async function shellLineWords(): Promise<string> {
  const record = await shellRecordIfAny()
  const words = record === null ? 'none found' : shellRecordWords(record)
  return process.platform === 'win32' ? `${words} — ${WINDOWS_SHELL_SENTENCE}` : words
}

export function describeShellRecord(record: ShellRecord): string {
  if (record.origin === 'shipped') return `bash ${record.version} at ${record.path} — the bash Mercury ships; the Bash tool runs under it`
  if (record.origin === 'system') return `bash ${record.version} at ${record.path} — the system's bash; the Bash tool runs under it because the shipped bash is absent or does not start (${shippedBashNote()})`
  return `brush ${record.version} at ${record.path} — Mercury's bundled bash-compatible engine; the Bash tool runs under it`
}

function shippedBashNote(): string {
  const pack = shippedBash()
  return pack.state === 'ok' ? `${pack.binaryPath} is present and did not answer` : pack.note
}

export function shellRoadWordsNow(): string {
  const record = shellRecordNow()
  return record === null ? 'bash — the bash Mercury ships, else the system\'s bash, else the bundled engine; which one is settled when the first command needs a shell' : describeShellRecord(record)
}

export type LoginFilesAbsence = { why: string; change: string }

let loginFilesAbsence: LoginFilesAbsence | null = null
let loginExportsAbsence: LoginFilesAbsence | null = null
const toldOfLoginFiles = new Set<string>()

export function noteLoginFiles(absence: LoginFilesAbsence | null): void {
  loginFilesAbsence = absence
}

export function noteLoginExports(absence: LoginFilesAbsence | null): void {
  loginExportsAbsence = absence
}

export function loginFilesNotCarried(): LoginFilesAbsence | null {
  return loginFilesAbsence
}

function loginFilesAbsences(defined: LoginFilesAbsence | null): Array<LoginFilesAbsence & { of: string }> {
  return [
    ...(defined === null ? [] : [{ of: 'bash login files define', ...defined }]),
    ...(loginExportsAbsence === null ? [] : [{ of: 'zsh login files export', ...loginExportsAbsence }]),
  ]
}

export function loginFilesLineOnce(reader: string): string | null {
  const absent = loginFilesAbsences(loginFilesAbsence)
  if (absent.length === 0 || toldOfLoginFiles.has(reader)) return null
  toldOfLoginFiles.add(reader)
  return absent.map(row => `Nothing your ${row.of} is carried in this session: ${row.why}. ${row.change}`).join('\n')
}

async function loginFilesSettled(): Promise<LoginFilesAbsence | null> {
  const { settleLoginFiles } = await import('./shellExec.js')
  await settleLoginFiles()
  return loginFilesAbsence
}

export function beginLoginFiles(): void {
  void loginFilesSettled().catch((error: unknown) => logForDebugging(`the login run was not begun: ${errorMessage(error)}`))
}

export type ShellRow = { status: 'ok' | 'warn'; evidence: string; fix?: string }

const SHELL_ROW_WAITS_MS = 15_000
const LAST_ROAD_FIX = 'Reinstall Mercury to restore the bash it ships, or install bash so that it is on PATH, then restart Mercury.'
const NO_SHELL_FOR_THE_MODEL = 'Bash cannot run in this session: no shell starts on this machine, and no shell tool is offered.'

let shellWordTold = false

function shellWordForTheUser(served: boolean): string | null {
  if (!served) return `No shell starts on this machine, so this session has no shell tool${passedOver.length > 0 ? ` — passed over: ${passedOver.join('; ')}` : ''}. ${windowsShellRoadActive() ? NO_SHELL_WAYS_OUT : LAST_ROAD_FIX}`
  const pin = pinPassedOver(passedOver)
  return pin === null ? null : `The shell you pinned does not serve this session — passed over: ${pin}. Serving instead: ${describeWindowsShellRoad().line}. ${PIN_WAYS_OUT}`
}

export async function shellWordOwed(): Promise<{ model: string | null; user: string | null }> {
  const served = (await shellRecordIfAny()) !== null
  const user = shellWordTold ? null : shellWordForTheUser(served)
  if (user !== null) shellWordTold = true
  return { model: served ? null : NO_SHELL_FOR_THE_MODEL, user }
}

const passedNow = (): string => (passedOver.length > 0 ? ` — passed over: ${passedOver.join('; ')}` : '')

function loginFilesRideIt(record: ShellRecord | null): boolean {
  return record !== null && record.origin !== 'engine' && !windowsShellRoadActive() && armedEngine() === null
}

function shellRowOf(record: ShellRecord | null, absent: LoginFilesAbsence | null): ShellRow {
  const pack = shippedBash()
  const skipped = pack.state === 'ok' ? null : pack.note
  const fix = skipped === null ? {} : { fix: `The bash pack is skipped in this install: ${skipped}` }
  if (windowsShellRoadActive()) {
    const passed = passedNow()
    const road = describeWindowsShellRoad()
    if (road.absent) return { status: 'warn', evidence: `${road.line}${passed}`, ...(road.fix === undefined ? {} : { fix: road.fix }) }
    if (record === null) return { status: 'warn', evidence: `${NO_WINDOWS_SHELL_MESSAGE}${passed}`, ...fix }
    const armed = armedEngine()
    const names = skipped !== null && !passed.includes(skipped) ? ` — this install carries no bash pack: ${skipped}` : ''
    const lastRoad = road.road === 'engine' && (armed === null || armed.arm === 'no-bash')
    if (road.bare === true) return { status: 'warn', evidence: `${road.line}${names}${passed}`, ...(road.fix === undefined ? {} : { fix: road.fix }) }
    return { status: lastRoad ? 'warn' : 'ok', evidence: `${road.line}${names}${passed}`, ...(lastRoad ? fix : {}) }
  }
  if (record === null) return { status: 'warn', evidence: `${NO_SHELL_MESSAGE}${passedNow()}`, fix: skipped === null ? LAST_ROAD_FIX : `The bash pack is skipped in this install: ${skipped}` }
  const armed = armedEngine()
  if (armed !== null) return { status: 'ok', evidence: `${describeShellRecord(record)} (${shellEngineArmWords(armed.arm)})${skipped === null ? '' : ` — this install carries no bash pack: ${skipped}`}` }
  if (record.origin === 'engine') {
    return { status: 'warn', evidence: `${describeShellRecord(record)}, because no bash starts on this machine${passedNow()}`, fix: skipped === null ? LAST_ROAD_FIX : `The bash pack is skipped in this install: ${skipped}` }
  }
  const absences = loginFilesAbsences(absent)
  if (absences.length > 0) {
    const change = absences.map(row => row.change).join(' ')
    return {
      status: 'warn',
      evidence: `${describeShellRecord(record)} — ${absences.map(row => `nothing the ${row.of} is carried: ${row.why}`).join('; ')}`,
      fix: record.origin === 'shipped' || skipped === null ? change : `${change} The bash pack is skipped in this install: ${skipped}`,
    }
  }
  if (record.origin === 'shipped') return { status: 'ok', evidence: describeShellRecord(record) }
  return { status: 'warn', evidence: describeShellRecord(record), ...fix }
}

export async function shellRow(waitMs: number = SHELL_ROW_WAITS_MS): Promise<ShellRow> {
  const settled = await withDeadline(shellRecordIfAny().then(record => ({ record })), waitMs, () => null)
  if (settled === null) {
    return {
      status: 'warn',
      evidence: `no shell has answered after ${waitMs / 1000} s${askedNow === null ? '' : `: ${askedNow} is being asked for its bash version and has ${START_PROBE_TIMEOUT_MS / 1000} s to answer`}${passedNow()}`,
      fix: `Run the health check again in a moment: a program that does not answer within ${START_PROBE_TIMEOUT_MS / 1000} s is passed over and named in this row.`,
    }
  }
  return shellRowOf(settled.record, loginFilesRideIt(settled.record) ? await loginFilesSettled() : null)
}

export function shellRowNow(): ShellRow {
  const record = shellRecordNow()
  if (record !== null || noneStarts) return shellRowOf(record, loginFilesAbsence)
  const road = describeWindowsShellRoad()
  const pack = shippedBash()
  const skipped = pack.state === 'ok' ? {} : { fix: `The bash pack is skipped in this install: ${pack.note}` }
  return { status: road.absent || pack.state !== 'ok' ? 'warn' : 'ok', evidence: road.line, ...(road.fix === undefined ? skipped : { fix: road.fix }) }
}

export const BASH_GLOB_PREAMBLE = 'shopt -u extglob 2>/dev/null || true'

export const PIPELINE_STATUS_ARRAY = '${PIPESTATUS[@]}'

export function snapshotProfileOf(origin: ShellOrigin): { kind: 'bash' | 'sh'; file: '.bashrc' | '.profile' } {
  return origin === 'engine' ? { kind: 'sh', file: '.profile' } : { kind: 'bash', file: '.bashrc' }
}

export const SNAPSHOT_KEEPS_ALIASES = 'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'

export const SNAPSHOT_READS_FUNCTIONS = 'echo "{ shopt -s extglob" >> "$SNAPSHOT_FILE"'

export const SNAPSHOT_READS_BACK = '( shopt -s extglob; eval "$(printf \'eval %q\' "$(declare -f -- "$__mercury_fn")")" ) >/dev/null 2>&1 || continue'

export const SNAPSHOT_READS_BACK_ALIASES = `compgen -a | while IFS= read -r __mercury_alias; do
  __mercury_shown=$(alias -- "$__mercury_alias" 2>/dev/null) || continue
  __mercury_value=\${__mercury_shown#*=\\'}
  __mercury_line=$(printf 'alias -- %s=%q' "$__mercury_alias" "\${__mercury_value%\\'}")
  ( unalias -a; eval "$__mercury_line"; [ "$(alias -- "$__mercury_alias")" = "$__mercury_shown" ] ) >/dev/null 2>&1 || continue
  printf '%s\\n' "$__mercury_line"
done`

export const SNAPSHOT_OPTIONS: readonly string[] = [
  `shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"`,
  `set -o | awk '$2 == "on" { print "set -o " $1 }' | head -n 1000 >> "$SNAPSHOT_FILE"`,
  SNAPSHOT_KEEPS_ALIASES,
]

export function argv0FunctionBody(argv0Name: string, quotedBinary: string, prepend: string): string {
  return `  if [ "\${BASHPID:-$$}" != "$$" ]; then
    exec -a ${argv0Name} ${quotedBinary} ${prepend}"$@"
  else
    ( exec -a ${argv0Name} ${quotedBinary} ${prepend}"$@" )
  fi`
}
