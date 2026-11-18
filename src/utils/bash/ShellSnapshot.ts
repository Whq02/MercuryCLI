import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { ripgrepCommand } from '../ripgrep.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { SNAPSHOT_KEEPS_ALIASES, SNAPSHOT_OPTIONS, argv0FunctionBody, snapshotProfileOf, type ShellRecord } from '../shell/shellRecord.js'
import { withShippedPrograms } from '../shell/windowsShellRoad.js'
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

type BoundedRun = { exitCode?: number; stdout: string; stderr: string; killed: boolean }

function runBounded(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  login: boolean,
): Promise<BoundedRun> {
  return new Promise(resolve => {
    let settled = false
    let guard: ReturnType<typeof setTimeout> | null = null
    const settle = (result: BoundedRun): void => {
      if (settled) return
      settled = true
      if (guard !== null) clearTimeout(guard)
      resolve(result)
    }
    const child = execFile(
      file,
      args,
      {
        windowsHide: true,
        encoding: 'utf8',
        env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(login ? { killSignal: 'SIGKILL' as const } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : undefined
          settle({ exitCode, stdout, stderr, killed: error.killed === true })
          return
        }
        settle({ exitCode: 0, stdout, stderr, killed: false })
      },
    )
    if (login) {
      let said = ''
      child.stdin?.end()
      child.stderr?.on('data', (chunk: string) => {
        said += chunk
      })
      child.once('exit', code => {
        if (code !== null) settle({ exitCode: code, stdout: '', stderr: said, killed: false })
      })
    }
    guard = setTimeout(() => {
      try {
        child.kill(login ? 'SIGKILL' : undefined)
      } catch {
      }
      settle({ exitCode: undefined, stdout: '', stderr: '', killed: true })
    }, timeoutMs + SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS)
  })
}

const defaultSnapshotPathExecutor: SnapshotPathExecutor = (file, args, timeoutMs) =>
  runBounded(file, args, { ...withShippedPrograms(subprocessEnv(), file) }, timeoutMs, false)

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

async function getMercurySnapshotContent(binShell: string): Promise<string> {
  const pathValue = await resolveSnapshotPathValue(binShell)
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
const OPTIONS_THAT_ARE_ON = `set -o | awk '$2 == "on" { print "set -o " $1 }' | head -n 1000 >> "$SNAPSHOT_FILE"`

function buildCaptureScript(args: {
  snapshotFilePath: string
  configFilePath: string
  configExists: boolean
  definitions: boolean
  optionsByState: boolean
  mercuryContent: string
}): string {
  const { snapshotFilePath, configFilePath, configExists, definitions, optionsByState, mercuryContent } = args
  const lines: string[] = []

  lines.push(`SNAPSHOT_FILE=${quote([snapshotFilePath])}`)

  if (configExists) {
    lines.push(`source ${quote([configFilePath])} < /dev/null`)
  } else {
    lines.push('# no user config file to source')
  }

  lines.push('echo "# Mercury shell environment snapshot" >| "$SNAPSHOT_FILE"')
  lines.push(`echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"`)

  if (definitions) {
    lines.push('echo "# Functions" >> "$SNAPSHOT_FILE"')
    lines.push(`for __mercury_fn in $(declare -F | awk '{print $NF}'); do
  case "$__mercury_fn" in
    _[!_]*) ;;
    *)
      __mercury_encoded=$(declare -f -- "$__mercury_fn" | base64 | tr -d '\\n')
      printf 'eval "$(printf %%s %s | base64 -d)" >/dev/null 2>&1\\n' "$__mercury_encoded" >> "$SNAPSHOT_FILE"
      ;;
  esac
done`)

    lines.push('echo "# Shell Options" >> "$SNAPSHOT_FILE"')
    lines.push(...(optionsByState ? SNAPSHOT_OPTIONS.map(line => (line.startsWith('set -o ') ? OPTIONS_THAT_ARE_ON : line)) : SNAPSHOT_OPTIONS))

    lines.push('echo "# Aliases" >> "$SNAPSHOT_FILE"')
    const winptyFilter = getPlatform() === 'windows' ? ' | grep -v winpty' : ''
    lines.push(`alias${winptyFilter} | sed 's/^alias /alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
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


let captureLeftNoFile: string | null = null

export function shellSnapshotAbsence(): string | null {
  return captureLeftNoFile
}

function randomSnapshotSuffix(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return suffix
}

export async function createAndSaveSnapshot(shell: Pick<ShellRecord, 'path' | 'origin'>): Promise<string | undefined> {
  const shellPath = shell.path
  try {
    const fs = getFsImplementation()
    const mercuryHome = getMercuryHome()
    const snapshotsDir = join(mercuryHome, 'shell-snapshots')
    await fs.mkdir(snapshotsDir)

    const profile = snapshotProfileOf(shell.origin)
    const configFilePath = join(homedir(), profile.file)

    const snapshotFilePath = join(
      snapshotsDir,
      `snapshot-${profile.kind}-${Date.now()}-${randomSnapshotSuffix()}.sh`,
    )

    const bashOfThisMachine = shell.origin !== 'engine' && getPlatform() !== 'windows'
    const configExists = await pathExists(configFilePath)
    const mercuryContent = await getMercurySnapshotContent(shellPath)
    const script = buildCaptureScript({
      snapshotFilePath,
      configFilePath,
      configExists,
      definitions: bashOfThisMachine || configExists,
      optionsByState: bashOfThisMachine,
      mercuryContent,
    })

    const inherited = withShippedPrograms(subprocessEnv(), shellPath)
    const captureEnv: NodeJS.ProcessEnv = {
      ...inherited,
      ...(bashOfThisMachine ? {} : { SHELL: shellPath }),
      GIT_EDITOR: 'true',
      MERCURY: '1',
    }

    const outcome = await runBounded(shellPath, ['-c', '-l', script], captureEnv, SNAPSHOT_CAPTURE_BOUND_MS, true)

    if (outcome.killed || outcome.exitCode !== 0) {
      captureLeftNoFile = outcome.killed
        ? `the login run of ${shellPath} did not end within ${SNAPSHOT_CAPTURE_BOUND_MS / 1000} s and was killed: a login file waits or runs long`
        : `the login run of ${shellPath} ended with exit ${String(outcome.exitCode)}`
      logForDebugging(
        [
          'shell snapshot capture failed',
          `  ${captureLeftNoFile}`,
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
      logError(`shell snapshot creation failed: ${captureLeftNoFile}`)
      return undefined
    }

    try {
      const stats = await stat(snapshotFilePath)
      logForDebugging(`shell snapshot created at ${snapshotFilePath} (${stats.size} bytes)`)
    } catch {
      captureLeftNoFile = `the login run of ${shellPath} ended before it wrote the snapshot: a login file ended the shell or handed it to another program`
      logForDebugging(`shell snapshot file missing after capture: ${snapshotFilePath} (${captureLeftNoFile})`)
      try {
        const entries = await fs.readdir(snapshotsDir)
        logForDebugging(`snapshots directory ${snapshotsDir} holds ${entries.length} entries`)
      } catch {
        logForDebugging(`snapshots directory ${snapshotsDir} no longer exists`)
      }
      return undefined
    }

    captureLeftNoFile = null
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
    captureLeftNoFile = `the login run of ${shellPath} could not be started: ${errorMessage(unexpectedError)}`
    logError(`shell snapshot creation failed: ${errorMessage(unexpectedError)}`)
    return undefined
  }
}
