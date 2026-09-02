import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { embeddedSearchToolsBinaryPath, hasEmbeddedSearchTools } from '../embeddedTools.js'
import { getMercuryHome } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { ripgrepCommand } from '../ripgrep.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { quote } from './shellQuote.js'


export type VersionedPathParts = {
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

const defaultSnapshotPathExecutor: SnapshotPathExecutor = (file, args, timeoutMs) =>
  new Promise(resolve => {
    let settled = false
    let guard: ReturnType<typeof setTimeout> | null = null
    const settle = (result: { exitCode?: number; stdout?: string }): void => {
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
        env: { ...subprocessEnv() },
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : undefined
          settle({ exitCode, stdout })
          return
        }
        settle({ exitCode: 0, stdout })
      },
    )
    guard = setTimeout(() => {
      try {
        child.kill()
      } catch {
      }
      settle({ exitCode: undefined, stdout: '' })
    }, timeoutMs + SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS)
  })

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
  if [ -n "$ZSH_VERSION" ]; then
    ARGV0=${argv0Name} ${quotedBinary} ${prepend}"$@"
  elif [ "\${BASHPID:-$$}" != "$$" ]; then
    exec -a ${argv0Name} ${quotedBinary} ${prepend}"$@"
  else
    ( exec -a ${argv0Name} ${quotedBinary} ${prepend}"$@" )
  fi
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

export type RipgrepShellIntegration = {
  type: 'alias' | 'function'
  snippet: string
}

export function createRipgrepShellIntegration(): RipgrepShellIntegration {
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

export function createFindGrepShellIntegration(): string | null {
  if (!hasEmbeddedSearchTools()) return null
  const binaryPath = embeddedSearchToolsBinaryPath()
  const findFunction = buildArgv0Function('find', 'bfs', binaryPath, [
    '-regextype',
    'findutils-default',
  ])
  const grepFunction = buildArgv0Function('grep', 'ugrep', binaryPath, [
    '-G',
    '--ignore-files',
    '--hidden',
    '-I',
    '--exclude-dir=.git',
    '--exclude-dir=.svn',
    '--exclude-dir=.hg',
    '--exclude-dir=.bzr',
    '--exclude-dir=.jj',
    '--exclude-dir=.sl',
  ])
  return `unalias find 2>/dev/null || true
unalias grep 2>/dev/null || true
${findFunction}
${grepFunction}`
}

async function getClaudeCodeSnapshotContent(binShell: string): Promise<string> {
  const pathValue = await resolveSnapshotPathValue(binShell)
  const rgIntegration = createRipgrepShellIntegration()
  const findGrep = createFindGrepShellIntegration()

  const sections: string[] = []
  sections.push('# Mercury search tools')
  sections.push(`if ! (unalias rg 2>/dev/null; command -v rg >/dev/null 2>&1); then
${rgIntegration.snippet}
fi`)
  if (findGrep !== null) {
    sections.push(findGrep)
  }
  sections.push('# Mercury PATH')
  sections.push(`export PATH=${quote([pathValue])}`)
  return sections.join('\n')
}


const MERCURY_CONTENT_DELIMITER = '__MERCURY_SNAPSHOT_CONTENT__'

function buildCaptureScript(args: {
  snapshotFilePath: string
  configFilePath: string
  configExists: boolean
  isZshLane: boolean
  mercuryContent: string
}): string {
  const { snapshotFilePath, configFilePath, configExists, isZshLane, mercuryContent } = args
  const lines: string[] = []

  lines.push(`SNAPSHOT_FILE=${quote([snapshotFilePath])}`)

  if (configExists) {
    lines.push(`source ${quote([configFilePath])} < /dev/null`)
  } else {
    lines.push('# no user config file to source')
  }

  lines.push('echo "# Mercury shell environment snapshot" >| "$SNAPSHOT_FILE"')
  lines.push(`echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"`)

  if (configExists) {
    lines.push('echo "# Functions" >> "$SNAPSHOT_FILE"')
    if (isZshLane) {
      lines.push(`for __mercury_fn in \${(k)functions}; do
  autoload +X -- "$__mercury_fn" >/dev/null 2>&1
done
for __mercury_fn in \${(k)functions}; do
  case "$__mercury_fn" in
    _[!_]*) ;;
    *) functions -- "$__mercury_fn" >> "$SNAPSHOT_FILE" ;;
  esac
done`)
    } else {
      lines.push(`for __mercury_fn in $(declare -F | awk '{print $NF}'); do
  case "$__mercury_fn" in
    _[!_]*) ;;
    *)
      __mercury_encoded=$(declare -f -- "$__mercury_fn" | base64 | tr -d '\\n')
      printf 'eval "$(printf %%s %s | base64 -d)" >/dev/null 2>&1\\n' "$__mercury_encoded" >> "$SNAPSHOT_FILE"
      ;;
  esac
done`)
    }

    lines.push('echo "# Shell Options" >> "$SNAPSHOT_FILE"')
    if (isZshLane) {
      lines.push(`setopt | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
    } else {
      lines.push(`shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"`)
      lines.push(`set -o | grep on | awk '{print $1}' | sed 's/^/set -o /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
      lines.push('echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"')
    }

    lines.push('echo "# Aliases" >> "$SNAPSHOT_FILE"')
    const winptyFilter = getPlatform() === 'windows' ? ' | grep -v winpty' : ''
    if (isZshLane) {
      lines.push(`alias${winptyFilter} | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
    } else {
      lines.push(`alias${winptyFilter} | sed 's/^alias /alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
    }
  } else if (!isZshLane) {
    lines.push('echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"')
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


type CaptureOutcome = {
  stdout: string
  stderr: string
  error?: Error & { code?: unknown; signal?: unknown; killed?: boolean }
}

function runCaptureShell(
  shellPath: string,
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<CaptureOutcome> {
  return new Promise(resolve => {
    execFile(
      shellPath,
      ['-c', '-l', script],
      { windowsHide: true, env, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ stdout, stderr, error })
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function randomSnapshotSuffix(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return suffix
}

export async function createAndSaveSnapshot(shellPath: string): Promise<string | undefined> {
  try {
    const fs = getFsImplementation()
    const mercuryHome = getMercuryHome()
    const snapshotsDir = join(mercuryHome, 'shell-snapshots')
    await fs.mkdir(snapshotsDir)

    const shellKind = shellPath.includes('zsh') ? 'zsh' : shellPath.includes('bash') ? 'bash' : 'sh'
    const configFileName =
      shellKind === 'zsh' ? '.zshrc' : shellKind === 'bash' ? '.bashrc' : '.profile'
    const configFilePath = join(homedir(), configFileName)
    const isZshLane = configFileName === '.zshrc'

    const snapshotFilePath = join(
      snapshotsDir,
      `snapshot-${shellKind}-${Date.now()}-${randomSnapshotSuffix()}.sh`,
    )

    const configExists = await pathExists(configFilePath)
    const mercuryContent = await getClaudeCodeSnapshotContent(shellPath)
    const script = buildCaptureScript({
      snapshotFilePath,
      configFilePath,
      configExists,
      isZshLane,
      mercuryContent,
    })

    const inherited = subprocessEnv()
    const captureEnv: NodeJS.ProcessEnv = {
      ...inherited,
      SHELL: shellPath,
      GIT_EDITOR: 'true',
      MERCURY: '1',
    }

    const outcome = await runCaptureShell(shellPath, script, captureEnv)

    if (outcome.error) {
      const error = outcome.error
      logForDebugging(
        [
          'shell snapshot capture failed',
          `  error: ${errorMessage(error)}`,
          `  code: ${String(error.code)} signal: ${String(error.signal)} killed: ${String(error.killed)}`,
          `  shell: ${shellPath}`,
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
      logError(`shell snapshot creation failed: ${errorMessage(error)}`)
      return undefined
    }

    try {
      const stats = await stat(snapshotFilePath)
      logForDebugging(`shell snapshot created at ${snapshotFilePath} (${stats.size} bytes)`)
    } catch {
      logForDebugging(`shell snapshot file missing after capture: ${snapshotFilePath}`)
      try {
        const entries = await fs.readdir(snapshotsDir)
        logForDebugging(`snapshots directory ${snapshotsDir} holds ${entries.length} entries`)
      } catch {
        logForDebugging(`snapshots directory ${snapshotsDir} no longer exists`)
      }
      return undefined
    }

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
    return undefined
  }
}
