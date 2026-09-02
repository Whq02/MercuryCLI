import { spawn, execFile } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { isInBundledMode } from './bundledMode.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

/**
 * Resolution, health and invocation of the search binary — system, vendored
 * builtin, or embedded in the self-contained bundle.
 */

export type RipgrepMode = 'system' | 'builtin' | 'embedded'

export type RipgrepConfig = {
  rgPath: string
  rgArgs: string[]
  argv0?: string
}

/** ripgrep's USAGE-shaped diagnostics — an invalid regex or flag — as
 *  distinct from its I/O lines (`rg: <path>: <os error>`): exit 2 covers
 *  BOTH shapes, and an unreadable or locked file beside zero matches is a
 *  COMPLETED search whose honest answer is "no matches", never a refusal
 *  (a held .ldb/.log in the walk
 *  is ordinary on Windows). Matched: the regex engine's parse errors and
 *  the argument parser's `error:`-led flag/value refusals. */
export function isRipgrepUsageDiagnostic(stderr: string): boolean {
  return /^error:|regex parse error|error parsing|unrecognized flag|invalid value/im.test(stderr)
}

/** ripgrep refused the invocation itself (exit 2 with a usage diagnostic
 *  and no output — an invalid regex, a bad flag). This used to come back as
 *  an empty result, so an invalid Grep pattern read "No matches found" and
 *  the model searched on with a pattern that never ran (TASK-014
 *  w4-f03-02). */
export class RipgrepUsageError extends Error {
  readonly diagnostic: string

  constructor(diagnostic: string) {
    super(`ripgrep rejected the search: ${diagnostic}`)
    this.name = 'RipgrepUsageError'
    this.diagnostic = diagnostic
  }
}

export class RipgrepTimeoutError extends Error {
  readonly partialResults: string[]

  constructor(message: string, partialResults: string[]) {
    super(message)
    this.name = 'RipgrepTimeoutError'
    this.partialResults = partialResults
  }
}

const OUTPUT_CAP = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_S = 20
const WSL_TIMEOUT_S = 60
const KILL_ESCALATION_MS = 5000
const RG_NAME = 'rg'

/** Fixed timeouts: no env override exists. */
function timeoutSeconds(): number {
  return getPlatform() === 'wsl' ? WSL_TIMEOUT_S : DEFAULT_TIMEOUT_S
}

/** The vendored layout, one step up from THIS module file — correct in both the flat bundle and the source tree; never branches on environment mode. */
function vendoredRgPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const platformDir = process.platform === 'win32' ? `${process.arch}-win32` : `${process.arch}-${process.platform}`
  return join(moduleDir, 'vendor', 'ripgrep', platformDir, process.platform === 'win32' ? 'rg.exe' : 'rg')
}

/** The source tree's search binary: the build vendors rg into the bundle
 *  from the `@vscode/ripgrep` devDependency, and a source-mode run (a proof
 *  under `bun run`, a dev boot) reads the same binary from the dependency's
 *  own layout — the platform package first, the postinstall copy second —
 *  by path alone (a runtime require of a dev package would not bundle).
 *  Null whenever neither binary exists. */
function devDependencyRg(): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const modules = join(moduleDir, '..', '..', 'node_modules', '@vscode')
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates = [
    join(modules, `ripgrep-${process.platform}-${process.arch}`, 'bin', exe),
    join(modules, 'ripgrep', 'bin', exe),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** The bare name, never the discovered absolute path — OS resolution rules (incl. the Windows cwd protection) must apply, so a malicious ./rg cannot be picked up. */
function systemRg(): string | null {
  const found = findExecutable(RG_NAME, [])
  return found.cmd !== RG_NAME ? RG_NAME : null
}

let resolvedConfig: { mode: RipgrepMode; config: RipgrepConfig } | null = null

/** Exported for the runtime drills: they resolve the SAME engine the tool
 *  will run (and skip honestly where the resolved binary is absent). */
export function resolveRipgrep(): { mode: RipgrepMode; config: RipgrepConfig } {
  if (resolvedConfig) return resolvedConfig
  let resolution: { mode: RipgrepMode; config: RipgrepConfig }
  // Every branch passes --no-config (FC-040): only the embedded branch
  // carried it, so an operator's RIPGREP_CONFIG_PATH silently rewrote every
  // search the harness ran — a --max-depth=1 in that file removed agents
  // from the inventory with no diagnostic. The harness's invocations are
  // never the operator's interactive rg; their rc file must not apply.
  if (isEnvDefinedFalsy(process.env.USE_BUILTIN_RIPGREP) && systemRg()) {
    resolution = { mode: 'system', config: { rgPath: RG_NAME, rgArgs: ['--no-config'] } }
  } else if (isInBundledMode()) {
    // The search engine is statically linked and dispatches on argv-zero.
    resolution = { mode: 'embedded', config: { rgPath: process.execPath, rgArgs: ['--no-config'], argv0: RG_NAME } }
  } else {
    const vendored = vendoredRgPath()
    const devRg = existsSync(vendored) ? null : devDependencyRg()
    if (existsSync(vendored)) {
      resolution = { mode: 'builtin', config: { rgPath: vendored, rgArgs: ['--no-config'] } }
    } else if (devRg !== null) {
      resolution = { mode: 'builtin', config: { rgPath: devRg, rgArgs: ['--no-config'] } }
    } else if (systemRg()) {
      resolution = { mode: 'system', config: { rgPath: RG_NAME, rgArgs: ['--no-config'] } }
    } else {
      // Builtin with the expected path so diagnostics report the real
      // location; the honest failure surfaces at first use.
      resolution = { mode: 'builtin', config: { rgPath: vendored, rgArgs: ['--no-config'] } }
    }
  }
  resolvedConfig = resolution
  return resolution
}

export function ripgrepCommand(): RipgrepConfig {
  return resolveRipgrep().config
}

function unavailableRemedy(expectedPath: string): string {
  return (
    `The search binary was not found at ${expectedPath} and no system ripgrep is on PATH. ` +
    `Rebuild with the vendor step, or install ripgrep via your platform package manager.`
  )
}

/**
 * The live availability truth (tool catalogue, capability centre, doctor).
 * Builtin-with-missing-file self-heals: when a system binary is now on
 * PATH, the memo is DROPPED so later spawns re-resolve.
 */
export function searchToolsAvailability(): {
  available: boolean
  mode: RipgrepMode | 'none'
  path: string
  remedy?: string
} {
  const { mode, config } = resolveRipgrep()
  if (mode === 'embedded' || mode === 'system') return { available: true, mode, path: config.rgPath }
  if (existsSync(config.rgPath)) return { available: true, mode: 'builtin', path: config.rgPath }
  if (systemRg()) {
    // A user who installs the tool mid-session gets working search on the
    // next call, no restart.
    resolvedConfig = null
    return { available: true, mode: 'system', path: RG_NAME }
  }
  return { available: false, mode: 'none', path: config.rgPath, remedy: unavailableRemedy(config.rgPath) }
}

// ---------------------------------------------------------------------------
// macOS codesign repair
// ---------------------------------------------------------------------------

let codesignChecked = false

/** Darwin only, once per process (the latch burns before the mode check), builtin only. Awaited before any spawn. */
async function maybeRepairCodesign(): Promise<void> {
  if (codesignChecked) return
  codesignChecked = true
  if (process.platform !== 'darwin') return
  const { mode, config } = resolveRipgrep()
  if (mode !== 'builtin') return
  const inspection = await execFileNoThrow('codesign', ['-dv', config.rgPath], { useCwd: false })
  const inspectionOutput = `${inspection.stdout}\n${inspection.stderr}`
  if (!inspectionOutput.split('\n').some(line => line.includes('linker-signed'))) return
  try {
    const sign = await execFileNoThrow(
      'codesign',
      ['--sign', '-', '--force', '--preserve-metadata=entitlements,requirements,flags,runtime', config.rgPath],
      { useCwd: false },
    )
    if (sign.code !== 0) logError(new Error(`codesign re-sign failed (${sign.code}): ${sign.stderr}`))
    const xattr = await execFileNoThrow('xattr', ['-d', 'com.apple.quarantine', config.rgPath], { useCwd: false })
    if (xattr.code !== 0 && xattr.stderr.trim() !== '') {
      logError(new Error(`quarantine removal failed (${xattr.code}): ${xattr.stderr}`))
    }
  } catch (err) {
    logError(err)
  }
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

type ProbeResult = { working: boolean; at: number; mode: RipgrepMode; path: string }

let probePromise: Promise<ProbeResult> | null = null

/** One-shot: exit 0 AND non-empty output AND the `ripgrep ` banner prefix. */
function probeHealth(): Promise<ProbeResult> {
  if (probePromise) return probePromise
  probePromise = (async (): Promise<ProbeResult> => {
    const { mode, config } = resolveRipgrep()
    try {
      let output: string
      let code: number | null
      if (config.argv0 !== undefined) {
        // The bundling runtime's own spawn API is what can set argv-zero.
        const child = Bun.spawn({
          cmd: [config.rgPath, ...config.rgArgs, '--version'],
          argv0: config.argv0,
          stdout: 'pipe',
          stderr: 'ignore',
        })
        output = await new Response(child.stdout as ReadableStream).text()
        code = await child.exited
      } else {
        const result = await execFileNoThrow(config.rgPath, [...config.rgArgs, '--version'], {
          timeout: 5000,
          useCwd: false,
        })
        output = result.stdout
        code = result.code
      }
      const working = code === 0 && output.length > 0 && output.startsWith('ripgrep ')
      logForDebugging(`ripgrep health: ${working ? 'working' : 'not working'} (mode ${mode}, path ${config.rgPath})`)
      return { working, at: Date.now(), mode, path: config.rgPath }
    } catch (err) {
      logForDebugging(`ripgrep health probe threw: ${String(err)}`)
      return { working: false, at: Date.now(), mode, path: config.rgPath }
    }
  })()
  return probePromise
}

let probeSettled: ProbeResult | null = null

/** Forces and AWAITS the probe — for callers (the doctor) that inspect status without running a search. Never re-spawns. */
export async function warmRipgrepStatus(): Promise<void> {
  probeSettled = await probeHealth()
}

export function getRipgrepStatus(): { mode: RipgrepMode | 'none'; path: string; working: boolean | null; present: boolean } {
  const { mode, config } = resolveRipgrep()
  // PRESENCE is mode-aware (FC-151): system mode's path is the BARE name by
  // design (OS resolution rules must apply), and the health row's
  // existsSync on it answered for a file named rg in the process CWD — a
  // 0-byte cwd file read present while a working PATH rg read MISSING,
  // the verdict flipping on the working directory alone. A bare name
  // resolves through the same PATH walk the spawn uses; an absolute path
  // keeps the plain existence test.
  const bare = !config.rgPath.includes('/') && !config.rgPath.includes('\\')
  const present = bare
    ? findExecutable(config.rgPath, []).cmd !== config.rgPath
    : existsSync(config.rgPath)
  return { mode, path: config.rgPath, working: probeSettled ? probeSettled.working : null, present }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

type SpawnOutcome = {
  stdout: string
  stderr: string
  error: (Error & { code?: string | number }) | null
  signal: NodeJS.Signals | null
}

/** The argv-zero shape: direct spawn, capped accumulation with per-stream truncation latches, latched settlement, escalating timeout off Windows. */
function spawnWithArgv0(
  config: RipgrepConfig,
  args: string[],
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise(resolvePromise => {
    const child = spawn(config.rgPath, args, {
      argv0: config.argv0,
      windowsHide: true,
      env: { ...subprocessEnv() },
      ...(abortSignal ? { signal: abortSignal } : {}),
    })
    let stdout = ''
    let stderr = ''
    let stdoutLatched = false
    let stderrLatched = false
    let settled = false
    let killedSignal: NodeJS.Signals | null = null

    const settle = (error: SpawnOutcome['error']): void => {
      // close and error are not mutually exclusive on Windows; a callback
      // invoked twice would resolve then try to reject.
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      resolvePromise({ stdout, stderr, error, signal: killedSignal })
    }

    let escalationTimer: ReturnType<typeof setTimeout> | null = null
    const timeoutTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        // Exactly one kill with the platform default; an explicit terminate
        // signal throws there.
        killedSignal = 'SIGTERM'
        child.kill()
        return
      }
      killedSignal = 'SIGTERM'
      child.kill('SIGTERM')
      // A process deep in a kernel wait ignores catchable signals; only the
      // uncatchable one is guaranteed to end it.
      escalationTimer = setTimeout(() => {
        killedSignal = 'SIGKILL'
        child.kill('SIGKILL')
      }, KILL_ESCALATION_MS)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLatched) return
      stdout += chunk.toString('utf8')
      if (stdout.length > OUTPUT_CAP) {
        stdout = stdout.slice(0, OUTPUT_CAP)
        stdoutLatched = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLatched) return
      stderr += chunk.toString('utf8')
      if (stderr.length > OUTPUT_CAP) {
        stderr = stderr.slice(0, OUTPUT_CAP)
        stderrLatched = true
      }
    })
    child.on('error', err => {
      settle(err as SpawnOutcome['error'])
    })
    child.on('close', (code, signal) => {
      if (signal) killedSignal = signal
      if (code === 0 || code === 1) {
        settle(null)
        return
      }
      const error = new Error(`ripgrep exited with code ${code}${signal ? ` (signal ${signal})` : ''}`) as SpawnOutcome['error'] &
        Error
      ;(error as { code?: string | number }).code = code ?? undefined
      settle(error)
    })
  })
}

function spawnExecFile(
  config: RipgrepConfig,
  args: string[],
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise(resolvePromise => {
    execFile(
      config.rgPath,
      args,
      {
        maxBuffer: OUTPUT_CAP,
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...subprocessEnv() },
        killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
        ...(abortSignal ? { signal: abortSignal } : {}),
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: string | number; signal?: NodeJS.Signals; killed?: boolean }) | null
        if (err && typeof err.code === 'number' && (err.code === 0 || err.code === 1)) {
          resolvePromise({ stdout, stderr, error: null, signal: err.signal ?? null })
          return
        }
        resolvePromise({ stdout, stderr, error: err, signal: err?.signal ?? null })
      },
    )
  })
}

function runSpawn(config: RipgrepConfig, args: string[], abortSignal: AbortSignal | undefined, timeoutMs: number): Promise<SpawnOutcome> {
  return config.argv0 !== undefined ? spawnWithArgv0(config, args, abortSignal, timeoutMs) : spawnExecFile(config, args, abortSignal, timeoutMs)
}

function splitOutput(raw: string): string[] {
  return raw
    .trim()
    .split('\n')
    .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter(line => line !== '')
}

// ---------------------------------------------------------------------------
// Main search
// ---------------------------------------------------------------------------

const EXHAUSTION_MARKERS = ['os error 11', 'Resource temporarily unavailable']

/**
 * A search answer that carries its own COMPLETENESS. An incomplete answer
 * is not a short one: a walk cut off by its deadline after emitting lines,
 * a failure outside the named errno set, and the output-cap overflow all
 * used to fall through to a bare `return salvaged`, so the tools rendered
 * "Found N files" or "No matches found" with no marker and the model
 * concluded a symbol was unused, a file absent, a refactor complete.
 */
export interface RipgrepAnswer {
  /** What the walk emitted — partial when `complete` is false. */
  lines: string[]
  /** The walk finished. False ⇒ `reason` says what stopped it. */
  complete: boolean
  /** The operator-facing sentence for an incomplete answer. */
  reason?: string
}

/** Options for one search. `timeoutMs` overrides the platform budget for a
 *  caller with its own deadline (a proof, a bounded coordinator walk). */
export interface RipgrepOptions {
  timeoutMs?: number
}

/**
 * The argument vector order: fixed configuration arguments, the
 * single-threaded pair on the retry only, the caller's arguments, then the
 * target (the tool hangs without a path off a terminal).
 *
 * The completeness-bearing door: every caller that renders an answer for
 * the model reads this one, so an unfinished walk can never be presented as
 * a finished search. The throwing cases stay exactly as they were — a
 * caller's own abort, a usage refusal, and a timeout with nothing salvaged.
 */
export async function ripGrepAnswer(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  options: RipgrepOptions = {},
): Promise<RipgrepAnswer> {
  await maybeRepairCodesign()
  // Fired, not awaited — with a rejection handler so a probe failure can
  // never become an unhandled rejection.
  probeHealth().then(
    result => {
      probeSettled = result
    },
    err => logForDebugging(`ripgrep health probe rejected: ${String(err)}`),
  )
  const timeoutMs = options.timeoutMs ?? timeoutSeconds() * 1000
  const timeoutS = timeoutMs / 1000
  const runOnce = (singleThreaded: boolean): Promise<SpawnOutcome> => {
    const { config } = resolveRipgrep()
    const vector = [...config.rgArgs, ...(singleThreaded ? ['-j', '1'] : []), ...args, target]
    return runSpawn(config, vector, abortSignal, timeoutMs)
  }
  let outcome = await runOnce(false)
  if (outcome.error && EXHAUSTION_MARKERS.some(marker => outcome.stderr.includes(marker))) {
    // Exactly one retry, single-threaded for that retry ONLY: a process that
    // stayed single-threaded afterwards timed out on large repositories.
    outcome = await runOnce(true)
  }
  if (!outcome.error) return { lines: splitOutput(outcome.stdout), complete: true }

  const code = (outcome.error as { code?: string | number }).code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    if (code === 'ENOENT') {
      const { config } = resolveRipgrep()
      outcome.error.message = `${outcome.error.message}\n${unavailableRemedy(config.rgPath)}`
    }
    throw outcome.error
  }

  let salvaged = splitOutput(outcome.stdout)
  // Cancelling and timing out are different facts: ABORT_ERR is the CALLER's
  // own abort (Esc, a keystroke past the interactive debounce) — folding it
  // into the timeout classifier minted "The search timed out after N
  // seconds" for a cancel, logged a fabricated failure, and told the model
  // to narrow a pattern nobody timed out on (TASK-017 S2,
  // ripgrep-cancel-reported-as-search-timeout).
  // One carve-out keeps deadline callers honest: AbortSignal.timeout() also
  // lands as ABORT_ERR, but its signal reason is a TimeoutError — that IS a
  // timeout and stays on the timeout arm (coordinatorTools bounds a walk
  // with exactly that shape).
  const signalTimedOut =
    abortSignal?.aborted === true &&
    (abortSignal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
  const isAbort = code === 'ABORT_ERR' && !signalTimedOut
  const isTimeout =
    outcome.signal === 'SIGTERM' || outcome.signal === 'SIGKILL' || (code === 'ABORT_ERR' && signalTimedOut)
  const isOverflow = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  const overflowReason = `the search output exceeded the ${OUTPUT_CAP / (1024 * 1024)}MB cap — results beyond it were dropped, so this answer is PARTIAL (${salvaged.length} line(s) kept); narrow the path or the pattern`
  if (isOverflow) {
    // The dropped remainder must reach a channel (FC-042): results beyond
    // the cap silently vanished — an agents inventory printed complete-
    // looking with the estate missing. It now reaches the MODEL too, on the
    // answer itself.
    logError(new Error(overflowReason))
  }
  if ((isTimeout || isAbort || isOverflow) && salvaged.length > 0 && !outcome.stdout.endsWith('\n')) {
    // The last line is incomplete ONLY when the received bytes stop
    // mid-line: a trailing newline proves the final line arrived whole
    // (FC-111 — the unconditional drop reported one result fewer than the
    // search had, and splitOutput's trim erases the evidence, so the RAW
    // bytes are what must be consulted).
    salvaged = salvaged.slice(0, -1)
  }
  logForDebugging(
    `ripgrep failed: signal=${outcome.signal ?? 'none'} code=${String(code ?? 'none')} stderr=${outcome.stderr.slice(0, 500)} salvaged=${salvaged.length}`,
  )
  // An abort is the caller's own decision; interactive search aborts on
  // every keystroke past the debounce, and code 2 is a usage error already
  // handled.
  if (code !== 2 && code !== 'ABORT_ERR') logError(outcome.error)
  // Exit 2 with NOTHING found and a USAGE-shaped diagnostic is ripgrep
  // refusing the invocation (an invalid regex, a bad flag) — never a search
  // that found nothing. Exit 2 beside real matches (a file the walk could
  // not read) still returns what it found, and an I/O-only stderr with no
  // matches is a COMPLETED search: [] stands, the refusal never fires.
  if (code === 2 && salvaged.length === 0 && isRipgrepUsageDiagnostic(outcome.stderr)) {
    throw new RipgrepUsageError(outcome.stderr.trim().split('\n').slice(0, 3).join(' '))
  }
  if (isAbort && salvaged.length === 0) {
    // Name the interruption so the tool layer's isAbortError sees an
    // interrupt (name === 'AbortError'), never an is_error tool_result.
    const abortError = new Error('The search was interrupted before it finished.')
    abortError.name = 'AbortError'
    throw abortError
  }
  if (isTimeout && salvaged.length === 0) {
    throw new RipgrepTimeoutError(
      `The search timed out after ${timeoutS} seconds. Files may have matched, but the walk did not finish — narrow the path or the pattern and try again.`,
      salvaged,
    )
  }
  // EVERY remaining road is an INCOMPLETE answer, and it says so. A timeout
  // that salvaged lines, an abort that salvaged lines, the output-cap
  // overflow, and the unclassified failure class (a ripgrep panic exiting
  // 101, a vendored rg.exe that is not a runnable image, descriptor or
  // memory exhaustion at spawn) each carry their own sentence — the last
  // one named, the way the usage refusal already is, with the exit code and
  // the stderr tail that explain it.
  const reason = isTimeout
    ? `the search timed out after ${timeoutS} seconds — the walk did not finish, so this answer is PARTIAL (${salvaged.length} line(s) kept); narrow the path or the pattern`
    : isAbort
      ? `the search was interrupted before it finished, so this answer is PARTIAL (${salvaged.length} line(s) kept)`
      : isOverflow
        ? overflowReason
        : `the search engine failed (exit ${String(code ?? 'unknown')}${outcome.signal ? `, signal ${outcome.signal}` : ''}): ${outcome.stderr.trim().split('\n').slice(0, 2).join(' ') || 'no diagnostic'} — this answer is INCOMPLETE`
  return { lines: salvaged, complete: false, reason }
}

/**
 * The plain door: the lines of a COMPLETE search. An incomplete answer is
 * never returned silently — it throws, carrying its partial lines, so a
 * caller that has not been taught to read completeness cannot mistake a cut
 * walk for a finished one.
 */
export async function ripGrep(args: string[], target: string, abortSignal: AbortSignal): Promise<string[]> {
  const answer = await ripGrepAnswer(args, target, abortSignal)
  if (!answer.complete) throw new RipgrepTimeoutError(answer.reason ?? 'the search did not finish', answer.lines)
  return answer.lines
}

// ---------------------------------------------------------------------------
// Streaming search
// ---------------------------------------------------------------------------

/**
 * Flushes complete lines as chunks arrive; deliberately minimal (no retry,
 * no stderr, no internal timeout). An abort racing close must not flush the
 * torn tail nor settle from close — the abort's error event settles.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await maybeRepairCodesign()
  const { config } = resolveRipgrep()
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(config.rgPath, [...config.rgArgs, ...args, target], {
      ...(config.argv0 !== undefined ? { argv0: config.argv0 } : {}),
      windowsHide: true,
      signal: abortSignal,
      env: { ...subprocessEnv() },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let carried = ''
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) rejectPromise(err)
      else resolvePromise()
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      carried += chunk.toString('utf8')
      const lines: string[] = []
      for (;;) {
        const newline = carried.indexOf('\n')
        if (newline === -1) break
        let line = carried.slice(0, newline)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        lines.push(line)
        carried = carried.slice(newline + 1)
      }
      if (lines.length > 0) onLines(lines)
    })
    child.on('error', err => settle(err))
    child.on('close', code => {
      if (abortSignal.aborted) {
        // Total settlement: an aborted stream still settles (the abort's
        // own error event usually got here first and this is a no-op) —
        // a bare return would leak the promise pending forever.
        settle()
        return
      }
      if (code === 0 || code === 1) {
        if (carried !== '') {
          const remainder = carried.endsWith('\r') ? carried.slice(0, -1) : carried
          onLines([remainder])
        }
        settle()
        return
      }
      settle(new Error(`ripgrep exited with code ${code}`))
    })
  })
}

// ---------------------------------------------------------------------------
// File counting
// ---------------------------------------------------------------------------

/** Counts newline bytes per chunk without materialising the listing. */
export async function countFilesWithRg(args: string[], target: string, abortSignal: AbortSignal): Promise<number> {
  await maybeRepairCodesign()
  const { config } = resolveRipgrep()
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(config.rgPath, [...config.rgArgs, ...args, target], {
      ...(config.argv0 !== undefined ? { argv0: config.argv0 } : {}),
      windowsHide: true,
      signal: abortSignal,
      env: { ...subprocessEnv() },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let count = 0
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) rejectPromise(err)
      else resolvePromise(count)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] === 0x0a) count++
      }
    })
    child.on('error', err => settle(err))
    child.on('close', code => {
      if (code === 0 || code === 1) settle()
      else settle(new Error(`ripgrep exited with code ${code}`))
    })
  })
}

const roundedCountMemo = new Map<string, Promise<number | undefined>>()

/**
 * The privacy-preserving telemetry counter. Counting the home directory
 * would descend into consent-gated folders and pop OS permission dialogs —
 * refused outright. Counts round to ONE SIGNIFICANT FIGURE at their own
 * magnitude (8→8, 42→40, 350→400, 750→800, 9999→10000) — the arithmetic,
 * not the stale source comment that claimed nearest-power-of-ten.
 */
export function countFilesRoundedRg(
  dirPath: string,
  abortSignal: AbortSignal,
  ignorePatterns: string[] = [],
): Promise<number | undefined> {
  const key = `${dirPath}\x00${ignorePatterns.join('\x00')}`
  const memoised = roundedCountMemo.get(key)
  if (memoised) return memoised
  const promise = (async (): Promise<number | undefined> => {
    try {
      if (resolve(dirPath) === homedir()) return undefined
      const args = ['--files', '--hidden']
      for (const pattern of ignorePatterns) args.push('--glob', `!${pattern}`)
      const count = await countFilesWithRg(args, dirPath, abortSignal)
      if (count === 0) return 0
      const magnitude = Math.pow(10, Math.floor(Math.log10(count)))
      return Math.round(count / magnitude) * magnitude
    } catch (err) {
      // Aborts are expected on large repositories (recognised by NAME).
      if (!(err instanceof Error && err.name === 'AbortError')) logError(err)
      return undefined
    }
  })()
  roundedCountMemo.set(key, promise)
  return promise
}
