import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { getInitialSettings } from '../settings/settings.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { which } from '../which.js'
import { bashPackProgramsDir, resolveBashPackDir, type BashPackResolution } from './bashPack.js'
import { resolveBrushPackDir } from './brushPack.js'
import { shellEngineArmWords, type ShellEngineArm } from './shellEngineArm.js'
import { bashToolAvailable, describeWindowsShellRoad, engineMayServe, settleWindowsShell, shippedWindowsBash, windowsBashCandidates, windowsShellRoadActive, withoutShellStartFiles } from './windowsShellRoad.js'

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

export function startedBashVersion(path: string, limitMs: number = START_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const asked = execFile(
        path,
        ['--norc', '--noprofile', '-c', 'printf %s "$BASH_VERSION"'],
        { windowsHide: true, timeout: limitMs, killSignal: 'SIGKILL', encoding: 'utf8', env: withoutShellStartFiles({ ...subprocessEnv() }) },
        (error, stdout) => {
          const version = typeof stdout === 'string' ? (stdout.trim().split(/\r?\n/).pop() ?? '').trim() : ''
          resolve(error || !BASH_VERSION_SHAPE.test(version) ? null : version)
        },
      )
      AbortSignal.timeout(limitMs).addEventListener(
        'abort',
        () => {
          asked.kill('SIGKILL')
          resolve(null)
        },
        { once: true },
      )
    } catch (error) {
      logForDebugging(`shell record: ${path} cannot be started — ${errorMessage(error)}`)
      resolve(null)
    }
  })
}

async function systemBashCandidates(): Promise<string[]> {
  const shell = process.env.SHELL ?? ''
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

async function posixSystemRecord(): Promise<ShellRecord> {
  const pack = shippedBash()
  if (pack.state === 'ok') {
    const version = await startedBashVersion(pack.binaryPath)
    if (version !== null) return { path: pack.binaryPath, dialect: 'bash', version, origin: 'shipped' }
    logForDebugging(`shell record: the shipped bash at ${pack.binaryPath} does not start; the system bash is next`)
  } else {
    logForDebugging(`shell record: no shipped bash (${pack.note}); the system bash is next`)
  }
  for (const candidate of await systemBashCandidates()) {
    const version = await startedBashVersion(candidate)
    if (version !== null) return { path: candidate, dialect: 'bash', version, origin: 'system' }
  }
  const engine = resolveBrushPackDir()
  if (engine.state === 'ok') {
    logForDebugging(`shell record: no bash starts on this machine; the bundled engine at ${engine.binaryPath} serves`)
    return { path: engine.binaryPath, dialect: 'bash', version: engine.manifest.version, origin: 'engine' }
  }
  logError(NO_SHELL_MESSAGE)
  throw new Error(NO_SHELL_MESSAGE)
}

let settledWindowsNotes: { passed: string[]; none: boolean } = { passed: [], none: false }

export function noSystemShellStarts(): boolean {
  return settledWindowsNotes.none
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
  })
  for (const line of choice.passed) logForDebugging(`shell record: ${line}`)
  settledWindowsNotes = { passed: choice.passed, none: choice.origin === 'none' }
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

export type ShellRow = { status: 'ok' | 'warn'; evidence: string; fix?: string }

export async function shellRow(): Promise<ShellRow> {
  const record = await shellRecordIfAny()
  const pack = shippedBash()
  const skipped = pack.state === 'ok' ? null : pack.note
  const fix = skipped === null ? {} : { fix: `The bash pack is skipped in this install: ${skipped}` }
  const onWindowsRoad = windowsShellRoadActive()
  const passed = onWindowsRoad && settledWindowsNotes.passed.length > 0 ? ` — passed over: ${settledWindowsNotes.passed.join('; ')}` : ''
  if (onWindowsRoad) {
    const road = describeWindowsShellRoad()
    if (road.absent) return { status: 'warn', evidence: `${road.line}${passed}`, ...(road.fix === undefined ? {} : { fix: road.fix }) }
    if (record === null) return { status: 'warn', evidence: `${NO_WINDOWS_SHELL_MESSAGE}${passed}`, ...fix }
    const armed = armedEngine()
    const names = skipped !== null && !passed.includes(skipped) ? ` — this install carries no bash pack: ${skipped}` : ''
    const lastRoad = road.road === 'engine' && (armed === null || armed.arm === 'no-bash')
    return { status: lastRoad ? 'warn' : 'ok', evidence: `${road.line}${names}${passed}`, ...(lastRoad ? fix : {}) }
  }
  if (record === null) return { status: 'warn', evidence: NO_SHELL_MESSAGE, ...fix }
  const armed = armedEngine()
  if (armed !== null) return { status: 'ok', evidence: `${describeShellRecord(record)} (${shellEngineArmWords(armed.arm)})${skipped === null ? '' : ` — this install carries no bash pack: ${skipped}`}` }
  if (record.origin === 'shipped') return { status: 'ok', evidence: describeShellRecord(record) }
  return { status: 'warn', evidence: describeShellRecord(record), ...fix }
}

export const BASH_GLOB_PREAMBLE = 'shopt -u extglob 2>/dev/null || true'

export const PIPELINE_STATUS_ARRAY = '${PIPESTATUS[@]}'

export function snapshotProfileOf(origin: ShellOrigin): { kind: 'bash' | 'sh'; file: '.bashrc' | '.profile' } {
  return origin === 'engine' ? { kind: 'sh', file: '.profile' } : { kind: 'bash', file: '.bashrc' }
}

export const SNAPSHOT_KEEPS_ALIASES = 'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'

export const SNAPSHOT_OPTIONS: readonly string[] = [
  `shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"`,
  `set -o | grep on | awk '{print $1}' | sed 's/^/set -o /' | head -n 1000 >> "$SNAPSHOT_FILE"`,
  SNAPSHOT_KEEPS_ALIASES,
]

export function argv0FunctionBody(argv0Name: string, quotedBinary: string, prepend: string): string {
  return `  if [ "\${BASHPID:-$$}" != "$$" ]; then
    exec -a ${argv0Name} ${quotedBinary} ${prepend}"$@"
  else
    ( exec -a ${argv0Name} ${quotedBinary} ${prepend}"$@" )
  fi`
}
