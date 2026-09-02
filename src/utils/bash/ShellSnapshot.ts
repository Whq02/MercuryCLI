/**
 * Shell environment snapshot.
 *
 * Captures the operator's interactive shell environment (functions, options,
 * aliases) once per session into a sourceable file, so every command runs
 * with the environment the operator expects without paying login-shell cost
 * per command — and bakes Mercury's bundled search tools and PATH into it.
 *
 * The capture is best-effort end to end: any failure yields no snapshot and
 * the caller falls back to a login shell. The harness must keep working,
 * just without the user's customisations.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (prover-covered)
// ─────────────────────────────────────────────────────────────────────────────

/** The versioned private-channel install layout split apart. */
export type VersionedPathParts = {
  versionsRoot: string
  version: string
  suffix: string
}

/**
 * Split an absolute path on the private-channel install layout
 * `<versionsRoot>/<version>/<suffix>`: a segment named `versions` followed by
 * exactly one version segment and a non-empty remainder. Both separator
 * styles are accepted; when several `versions` segments exist the LAST one
 * wins. Any other layout (repo checkouts, system installs) returns null.
 */
export function deriveVersionedPathParts(path: string): VersionedPathParts | null {
  // The greedy prefix makes the match land on the last `versions` segment.
  const match = /^(.*[/\\]|)(versions)[/\\]([^/\\]+)([/\\].+)$/.exec(path)
  if (!match) return null
  return {
    versionsRoot: `${match[1]}${match[2]}`,
    version: match[3] as string,
    suffix: match[4] as string,
  }
}

const POSIX_SHELL_BASENAMES: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh', 'dash'])

/**
 * Whether the resolved snapshot shell is a POSIX sh-family shell, decided by
 * exact basename (lowercased, optional `.exe` tolerated). Exactness matters:
 * the PowerShell binaries end in the same two letters as `sh` and must never
 * match a substring test.
 */
export function isPosixSnapshotShell(shellPath: string): boolean {
  const segments = shellPath.split(/[/\\]/)
  const basename = (segments[segments.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '')
  return POSIX_SHELL_BASENAMES.has(basename)
}

/** The hermetic-executor shape used by the PATH resolver's probe. */
type SnapshotPathExecutor = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ exitCode?: number; stdout?: string }>

/**
 * The PATH probe's bound — the same 10 s the capture child below runs under.
 * The probe fires on the first Bash call of a session and is awaited by the
 * memoized shell configuration, so an unbounded child was sticky for the
 * whole session: the System32 bash.exe launcher waiting on a WSL distro that
 * never comes up, a BASH_ENV script blocked on an unreachable mapped drive,
 * a shell on a stalled network path — each left every Bash call pending with
 * no message, forever. On expiry the answer is the process PATH, the
 * documented outcome for every other unsatisfactory probe.
 */
const SNAPSHOT_PATH_PROBE_TIMEOUT_MS = 10_000
/** How long past the kill the probe still waits for the child's `close`. */
const SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS = 250

/** Default probe executor: a direct process launch (never a platform-shell
 * string) that reports a non-zero exit as a result instead of rejecting,
 * bounded twice — the launcher's own timeout kills the child, and a settle
 * guard answers even when the callback never comes: it rides the child's
 * `close`, which a grandchild holding the inherited stdout pipe (a launcher
 * that spawned the real shell and exited) withholds past the kill. */
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
          // A timeout kill reports no numeric code — refused by the resolver.
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
        /* already gone */
      }
      settle({ exitCode: undefined, stdout: '' })
    }, timeoutMs + SNAPSHOT_PATH_PROBE_SETTLE_GRACE_MS)
  })

/**
 * Resolve the PATH value the snapshot exports.
 *
 * Off Windows — and on Windows when the resolved shell is not POSIX — the
 * answer is the current process PATH. On Windows with a POSIX shell, the
 * shell is asked for its own PATH, because the process PATH is the native
 * Windows one while the shell lives in a Cygwin-style world. The probe must
 * ride the resolved binary itself with the command-string flag: the platform
 * command interpreter does not expand `$PATH` — it echoes the literal back
 * with exit 0, and baking that single token breaks every lookup made through
 * the snapshot. The answer is accepted only when the exit status is present
 * and zero, the trimmed output is non-empty, it is not the unexpanded
 * literal, and it contains at least one forward slash; anything else —
 * including a thrown spawn error or a probe that outlives its bound — falls
 * back to the process PATH.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Generated shell text: the argv[0] shim, ripgrep and find/grep integrations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A shell function that runs a multi-tool binary under a forced argv[0] so
 * it dispatches as `argv0Name`. Under zsh, and on Windows hosts (MSYS/
 * Cygwin/Win32, where exec's argv[0] replacement does not work), the bundled
 * runtime's native `ARGV0` variable carries the name instead. With exec, the
 * replacement happens directly when the function already runs in a subshell
 * (own pid differing from `$$`), and inside an explicit subshell otherwise
 * so the caller's shell is not replaced.
 *
 * The binary path is shell-quoted; prepended default arguments are injected
 * literally (each must already be one safe shell word); the caller's
 * arguments are forwarded with word boundaries intact.
 */
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

/**
 * The resilient ripgrep function. The earlier shape froze one
 * absolute vendored path into an alias, so the moment an update pruned that
 * version's directory the alias pointed at nothing for the rest of the
 * session; a function can re-decide at call time. It tries, in order, and
 * returns the status of whichever attempt it takes: the baked path; for
 * managed install layouts, the version the channel pointer names right now;
 * a system rg invoked in a form that cannot recurse into this function or a
 * user alias; and finally one honest line and status 127.
 */
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

/** The shape of the ripgrep integration baked into the snapshot. */
export type RipgrepShellIntegration = {
  type: 'alias' | 'function'
  snippet: string
}

/**
 * How `rg` is made reachable, chosen by how ripgrep is reachable in this
 * build: an embedded multi-tool binary gets the argv[0] shim (forwarding
 * ONLY the caller's arguments — no defaults on that branch); a bare command
 * name resolved through PATH gets a plain alias (PATH resolution already
 * happens at call time); an absolute vendored path gets the resilient
 * function above.
 */
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

/**
 * The find/grep shadowing block — only in builds carrying the embedded
 * search tools, and unlike ripgrep it shadows the system tools
 * unconditionally: the embedded replacements are drop-in, and the point is
 * that every invocation gets the same fast implementation. Any find/grep
 * alias is cleared first, because alias expansion resolves before function
 * lookup and a user's renaming alias would win over the shim.
 *
 * The prepended defaults are behaviourally load-bearing (a later
 * user-supplied flag still overrides): find gets the findutils regex
 * flavour, because the embedded default cannot express backslash-
 * alternation; grep gets basic-regex mode, .gitignore respect, hidden files,
 * binary skipping and the VCS directory exclusions. The dedicated search
 * tools' output-width cap (hard truncation corrupts downstream readers) and
 * their permission-dependent exclusions are deliberately left out.
 */
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

/**
 * Mercury's whole contribution to the snapshot: the ripgrep guard and
 * integration, the find/grep shadowing block when the build carries the
 * embedded tools, and the exported PATH.
 */
async function getClaudeCodeSnapshotContent(binShell: string): Promise<string> {
  const pathValue = await resolveSnapshotPathValue(binShell)
  const rgIntegration = createRipgrepShellIntegration()
  const findGrep = createFindGrepShellIntegration()

  const sections: string[] = []
  sections.push('# Mercury search tools')
  // Define Mercury's rg only when no real rg is reachable. The probe
  // neutralises user aliases first — an alias like `rg='rg --smart-case'`
  // would mask the real-binary check — and runs in a subshell so the alias
  // table of the sourcing shell is untouched.
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

// ─────────────────────────────────────────────────────────────────────────────
// The capture script
// ─────────────────────────────────────────────────────────────────────────────

const MERCURY_CONTENT_DELIMITER = '__MERCURY_SNAPSHOT_CONTENT__'

/**
 * Build the script the resolved shell runs (as an interactive-style login
 * capture) to write the snapshot file. Ordered steps: bind the target path;
 * source the user's config with stdin from /dev/null (a config that reads
 * stdin must not hang the capture) when it exists; create-or-truncate the
 * file with the clobbering form so `noclobber` cannot leave it stale or
 * missing; lay down the unalias-everything guard as the first executable
 * line (a function body captures the alias table as of definition time, so
 * the replayed definitions must land with aliases off); emit the user's
 * functions, options and aliases; append Mercury's content; and fail loudly
 * if the file does not exist at the end.
 */
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
      // Force autoloadable functions to load so their bodies can be dumped,
      // then write each surviving definition directly. Names starting with
      // an underscore followed by a non-underscore are completion machinery
      // and are skipped; double-underscore helpers and a bare `_` survive.
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
      // The bash lane round-trips each definition through base64 and emits a
      // self-decoding evaluation with output and errors discarded, so any
      // special characters inside function bodies survive the file
      // round-trip.
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
      // The `grep on` substring pick is a faithfully reproduced quirk of the
      // observed behaviour: it also emits options whose NAME contains the
      // on-token (`monitor`, `onecmd`) regardless of their actual state. Do
      // not "fix" this without a decision — it is recorded as an
      // open risk in the slice spec.
      lines.push(`shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"`)
      lines.push(`set -o | grep on | awk '{print $1}' | sed 's/^/set -o /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
      lines.push('echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"')
    }

    lines.push('echo "# Aliases" >> "$SNAPSHOT_FILE"')
    // The end-of-options form keeps an alias whose name begins with a dash
    // from being read as a flag when the snapshot is sourced. On Windows
    // hosts, Git Bash manufactures winpty wrapper aliases for console
    // programs; they abort without a terminal attached, so they are dropped
    // before the cap is applied.
    const winptyFilter = getPlatform() === 'windows' ? ' | grep -v winpty' : ''
    if (isZshLane) {
      lines.push(`alias${winptyFilter} | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
    } else {
      lines.push(`alias${winptyFilter} | sed 's/^alias /alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`)
    }
  } else if (!isZshLane) {
    // With no config file the bash-shaped lane still needs alias expansion
    // switched on, or the replayed aliases would be ignored; the zsh lane
    // emits nothing in that case.
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

// ─────────────────────────────────────────────────────────────────────────────
// Capture lifecycle
// ─────────────────────────────────────────────────────────────────────────────

type CaptureOutcome = {
  stdout: string
  stderr: string
  error?: Error & { code?: unknown; signal?: unknown; killed?: boolean }
}

/** Run the capture child under the 10 s / 1 MiB limits, never rejecting. */
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

/** Six random base36 characters, enough to keep concurrent sessions apart. */
function randomSnapshotSuffix(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return suffix
}

/**
 * Capture the user's shell environment into a snapshot file. Resolves to the
 * snapshot path, or to undefined on any failure — this entry never rejects.
 */
export async function createAndSaveSnapshot(shellPath: string): Promise<string | undefined> {
  try {
    const fs = getFsImplementation()
    const mercuryHome = getMercuryHome()
    const snapshotsDir = join(mercuryHome, 'shell-snapshots')
    await fs.mkdir(snapshotsDir)

    // Shell kind and config file are derived independently by path
    // substring; everything downstream branches on the chosen config file
    // name, so a `.profile` shell rides the bash-shaped lane throughout.
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

    // The capture child always inherits the subprocess environment — no
    // opt-out env exists.
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
      // Nothing is unlinked and no cleanup is registered on this path; a
      // partially written snapshot file simply stays where it is.
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
