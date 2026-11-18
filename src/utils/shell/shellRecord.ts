import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { getInitialSettings } from '../settings/settings.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { which } from '../which.js'
import { resolveBashPackDir, type BashPackResolution } from './bashPack.js'
import { resolveBrushPackDir } from './brushPack.js'
import { windowsShellRoadActive } from './windowsShellRoad.js'

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

function startedBashVersion(path: string): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile(
        path,
        ['--norc', '--noprofile', '-c', 'printf %s "$BASH_VERSION"'],
        { windowsHide: true, timeout: START_PROBE_TIMEOUT_MS, encoding: 'utf8', env: { ...subprocessEnv() } },
        (error, stdout) => {
          const version = typeof stdout === 'string' ? stdout.trim() : ''
          resolve(error || version === '' ? null : version)
        },
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

async function windowsShellPath(): Promise<string> {
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

let settledSystemRecord: ShellRecord | null = null

export function systemShellAt(path: string): ShellRecord {
  return { path, dialect: 'bash', version: '', origin: 'system' }
}

export const systemShellRecord = memoize(async (): Promise<ShellRecord> => {
  const record = windowsShellRoadActive() ? systemShellAt(await windowsShellPath()) : await posixSystemRecord()
  settledSystemRecord = record
  return record
})

export async function fallbackEngineBinary(): Promise<string | null> {
  if (windowsShellRoadActive()) return null
  const record = await systemShellRecord()
  return record.origin === 'engine' ? record.path : null
}

function armedEngineRecord(): ShellRecord | null {
  const { resolveShellEngine } = require('./engineSession.js') as typeof import('./engineSession.js')
  const engine = resolveShellEngine(getInitialSettings().shell?.engine)
  return engine.engine === 'brush' ? { path: engine.binaryPath, dialect: 'bash', version: engine.version, origin: 'engine' } : null
}

export async function shellRecord(): Promise<ShellRecord> {
  return armedEngineRecord() ?? systemShellRecord()
}

export function shellRecordNow(): ShellRecord | null {
  return armedEngineRecord() ?? settledSystemRecord
}

export function windowsShellName(): string {
  const shellRaw = process.env.SHELL ?? 'unknown'
  return shellRaw.includes('zsh') ? 'zsh' : shellRaw.includes('bash') ? 'bash' : shellRaw
}

export function completionDialect(): ShellDialect | null {
  if (process.platform === 'win32') return windowsShellName() === 'bash' ? 'bash' : null
  return 'bash'
}

export function profileShellWords(record: ShellRecord | null): string {
  return windowsShellRoadActive() ? 'bash or zsh' : (record?.dialect ?? 'bash')
}

export const OLD_BASH_SENTENCE =
  "on this bash a here-document inside $( ) breaks when its text holds an unpaired quote, backquote or parenthesis or a line ending in a backslash, so give such text to the command on standard input instead (git commit -F - <<'EOF')"

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
  if (!windowsShellRoadActive()) await shellRecordIfAny()
}

export async function shellLineWords(): Promise<string> {
  const record = await shellRecordIfAny()
  return record === null ? 'none found' : shellRecordWords(record)
}

export function describeShellRecord(record: ShellRecord): string {
  if (record.origin === 'shipped') return `bash ${record.version} at ${record.path} — the bash Mercury ships; the Bash tool runs under it`
  if (record.origin === 'system') return `bash ${record.version} at ${record.path} — the system's bash; the Bash tool runs under it${windowsShellRoadActive() ? '' : ` because the shipped bash is absent or does not start (${shippedBashNote()})`}`
  return `brush ${record.version} at ${record.path} — Mercury's bundled bash-compatible engine; the Bash tool runs under it`
}

function shippedBashNote(): string {
  const pack = shippedBash()
  return pack.state === 'ok' ? `${pack.binaryPath} is present and did not answer` : pack.note
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
