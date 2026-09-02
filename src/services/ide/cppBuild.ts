// ============================================================================
//  ide/cppBuild — C/C++ build operations as typed service functions (ide
// The primitives's launch profiles and's closed
//  loop consume — deliberately NOT a model-facing tool in this slice.
//
//  Contract:
//    · every run op returns a TYPED CppBuildRun: the exact argv, exit code,
//      bounded output tail (full output spills to the artifact store —
//      mercury://artifact/ide-cpp/…), duration, and the compile-DB path the
//      run produced/refreshed (verified on disk, with an explicit
//      "visible to clangd" bit — probeCompileDb's walk only sees the root
//      and build/ locations, so a preset writing elsewhere produces a DB
//      clangd will NOT pick up without a .clangd config);
//    · NEVER auto-rewrites user build files: configureConventional (the
//      documented remedy, cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON)
//      REFUSES when the project declares presets — the preset is the
//      author's intent; clean goes through the build system's own clean
//      target, never a recursive delete;
//    · cmake is probed (PATH, 30s env-keyed cache), never vendored, never
//      package-manager-guessed — an absent binary is a typed refusal with
//      the install remedy;
//    · refusal-before-spawn checks are ordered so they stay deterministic on
//      cmake-less machines (preset/build-dir validation precedes the binary
//      probe).
//
//  Proof: scripts/ide/prove-cpp-project.ts (typed refusals everywhere; the
//  real-cmake legs run when the machine has cmake, loud-skip otherwise).
// ============================================================================

import { spawn } from 'node:child_process'
import { settleChildRun } from '../../utils/childSettle.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { storeArtifact } from '../../utils/artifacts/store.js'
import { whichSync } from '../../utils/which.js'
import {
  buildCppProjectProfile,
  cppCompileDbVerdict,
  parseCMakePresets,
  type CppCmakePreset,
  type CppProjectProfile,
} from './cppProject.js'

export type CppBuildOp = 'configure-preset' | 'configure-conventional' | 'build' | 'clean'

export interface CppBuildRun {
  op: CppBuildOp
  ok: boolean
  /** Exact argv (empty when refused before spawn). */
  argv: string[]
  /** null = never spawned (refusal) or killed by signal. */
  exitCode: number | null
  signal?: string
  durationMs: number
  /** Bounded tail (stdout+stderr interleaved, last OUTPUT_TAIL_LINES lines). */
  outputTail: string[]
  /** Full output artifact when the tail truncates (mercury://artifact/ide-cpp/<id>). */
  artifactRef?: string
  /** compile_commands.json this run produced/refreshed — verified on disk. */
  compileDb?: string
  /** Whether probeCompileDb (the clangd truth walk) now returns that DB. */
  compileDbVisibleToClangd?: boolean
  detail: string
}

export interface CMakePresetListing {
  state: 'ok' | 'no-presets' | 'error'
  presetsFile?: string
  configurePresets: CppCmakePreset[]
  buildPresets: string[]
  detail: string
}

const OUTPUT_TAIL_LINES = 40
const OUTPUT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 300_000
const CMAKE_PROBE_TTL_MS = 30_000

// ── cmake probe (cached, env-keyed) ──────────────────────────────────────────

let cmakeCache: { at: number; key: string; path: string | null } | null = null

/** TEST-ONLY: drop the cmake probe cache (PATH-scrub refusal proofs). */
export function _resetCppBuildForTesting(): void {
  cmakeCache = null
}

function probeCmake(): string | null {
  const key = process.env.PATH ?? ''
  if (cmakeCache && cmakeCache.key === key && Date.now() - cmakeCache.at < CMAKE_PROBE_TTL_MS) {
    return cmakeCache.path
  }
  const found = whichSync('cmake') ?? null
  cmakeCache = { at: Date.now(), key, path: found }
  return found
}

const CMAKE_REMEDY =
  'cmake is not on PATH — install CMake (brew install cmake · apt install cmake) to use the build ops'

// ── the runner ───────────────────────────────────────────────────────────────

function refusal(op: CppBuildOp, detail: string): CppBuildRun {
  return { op, ok: false, argv: [], exitCode: null, durationMs: 0, outputTail: [], detail }
}

async function spillOutput(op: CppBuildOp, lines: string[]): Promise<string | undefined> {
  if (lines.length <= OUTPUT_TAIL_LINES) return undefined
  const { id } = await storeArtifact({
    scope: 'ide-cpp',
    name: `cmake-${op}`,
    content: lines.join('\n'),
    kind: 'build-output',
  })
  return id ? `mercury://artifact/ide-cpp/${id}` : undefined
}

/** The compile-DB truth pair for a run: the file the run left on disk (when
 *  it exists) and whether the clangd walk from `from` now finds it. */
function compileDbTruth(
  candidateDir: string | undefined,
  from: string,
): { compileDb?: string; compileDbVisibleToClangd?: boolean } {
  if (!candidateDir) return {}
  const db = path.join(candidateDir, 'compile_commands.json')
  if (!existsSync(db)) return {}
  const verdict = cppCompileDbVerdict(from)
  return {
    compileDb: db,
    compileDbVisibleToClangd: verdict.state === 'ok' && path.resolve(verdict.path) === path.resolve(db),
  }
}

async function runCmake(options: {
  op: CppBuildOp
  cmakePath: string
  args: string[]
  cwd: string
  from: string
  /** Directory whose compile_commands.json this run should have produced/refreshed. */
  expectDbDir?: string
  timeoutMs?: number
}): Promise<CppBuildRun> {
  const argv = [options.cmakePath, ...options.args]
  const startedAt = Date.now()
  const lines: string[] = []
  let bytes = 0
  let truncated = false
  // Chunks are STREAM SLICES, not lines (the §STREAM-CHUNK-AS-LINE
  // class) — reassemble on newlines so the tail never carries broken lines.
  let partial = ''
  const push = (chunk: Buffer): void => {
    if (truncated) return
    bytes += chunk.length
    if (bytes > OUTPUT_MAX_BYTES) truncated = true
    partial += String(chunk)
    for (;;) {
      const nl = partial.indexOf('\n')
      if (nl === -1) return
      const line = partial.slice(0, nl).trimEnd()
      partial = partial.slice(nl + 1)
      if (line) lines.push(line)
    }
  }
  const flushPartial = (): void => {
    const rest = partial.trimEnd()
    partial = ''
    if (rest) lines.push(rest)
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = await new Promise<{ exitCode: number | null; signal?: string; timedOut: boolean }>(
    resolve => {
      // env spread is load-bearing: Bun's spawn drops live env mutations
      // unless the whole env is passed explicitly (the recorded house lesson).
      const child = spawn(options.cmakePath, options.args, {
        windowsHide: true,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...subprocessEnv() },
      })
      child.stdout.on('data', push)
      child.stderr.on('data', push)
      // The shared settle owner: the CMake driver's generator, compiler and
      // linker are DESCENDANTS — a root-only kill left them holding the
      // object, PDB and executable files the next build must open.
      void settleChildRun(child, { timeoutMs }).then(settlement => {
        if (settlement.spawnError !== undefined) {
          lines.push(`spawn error: ${settlement.spawnError}`)
          resolve({ exitCode: null, timedOut: false })
          return
        }
        if (settlement.timedOut) {
          resolve({ exitCode: null, signal: 'SIGKILL', timedOut: true })
          return
        }
        resolve({
          exitCode: settlement.code,
          ...(settlement.signal ? { signal: settlement.signal } : {}),
          timedOut: false,
        })
      })
    },
  )
  flushPartial()
  if (truncated) lines.push(`(output exceeded ${OUTPUT_MAX_BYTES} bytes — capture truncated)`)
  const artifactRef = await spillOutput(options.op, lines)
  const ok = result.exitCode === 0
  const dbTruth = ok ? compileDbTruth(options.expectDbDir, options.from) : {}
  return {
    op: options.op,
    ok,
    argv,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    durationMs: Date.now() - startedAt,
    outputTail: lines.slice(-OUTPUT_TAIL_LINES),
    ...(artifactRef ? { artifactRef } : {}),
    ...dbTruth,
    detail: result.timedOut
      ? `cmake ${options.args[0] ?? ''} exceeded ${timeoutMs}ms — killed`
      : ok
        ? `cmake exited 0${dbTruth.compileDb ? ` — compile DB at ${dbTruth.compileDb}${dbTruth.compileDbVisibleToClangd ? ' (visible to clangd)' : ' (NOT on the clangd walk — root/build/ only; a .clangd CompilationDatabase entry can point clangd at it)'}` : ''}`
        : `cmake exited ${result.exitCode ?? `null (${result.signal ?? 'spawn failure'})`} — see outputTail${artifactRef ? ` / ${artifactRef}` : ''}`,
  }
}

// ── the operations ───────────────────────────────────────────────────────────

/** List the project's CMake presets — a pure file parse (works without cmake
 *  on PATH; malformed JSON is a typed error, never a throw). */
export function listCMakePresets(from: string = getCwd()): CMakePresetListing {
  const profile = buildCppProjectProfile(from)
  const parsed = parseCMakePresets(profile.projectRoot)
  if (parsed.presetsError) {
    return {
      state: 'error',
      ...(parsed.presetsFile ? { presetsFile: parsed.presetsFile } : {}),
      configurePresets: parsed.presets,
      buildPresets: parsed.buildPresets,
      detail: `presets file did not parse: ${parsed.presetsError}`,
    }
  }
  if (!parsed.presetsFile) {
    return {
      state: 'no-presets',
      configurePresets: [],
      buildPresets: [],
      detail: 'no CMakePresets.json — configureConventional is the documented path',
    }
  }
  return {
    state: 'ok',
    presetsFile: parsed.presetsFile,
    configurePresets: parsed.presets,
    buildPresets: parsed.buildPresets,
    detail: `${parsed.presets.length} configure preset(s), ${parsed.buildPresets.length} build preset(s)`,
  }
}

/** `cmake --preset <name>` — configure through the author's declared intent. */
export async function configurePreset(
  name: string,
  from: string = getCwd(),
  opts?: { timeoutMs?: number },
): Promise<CppBuildRun> {
  const profile = buildCppProjectProfile(from)
  const listing = listCMakePresets(from)
  const preset = listing.configurePresets.find(p => p.name === name)
  if (!preset) {
    const known = listing.configurePresets.map(p => p.name)
    return refusal(
      'configure-preset',
      known.length
        ? `unknown configure preset '${name}' — declared: ${known.join(', ')}`
        : `no configure presets declared (${listing.detail})`,
    )
  }
  const cmakePath = probeCmake()
  if (!cmakePath) return refusal('configure-preset', CMAKE_REMEDY)
  return runCmake({
    op: 'configure-preset',
    cmakePath,
    args: ['--preset', name],
    cwd: profile.projectRoot,
    from,
    ...(preset.binaryDir && !preset.binaryDir.includes('${')
      ? { expectDbDir: preset.binaryDir }
      : { expectDbDir: path.join(profile.projectRoot, 'build') }),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
}

/**
 * The documented remedy, verbatim: `cmake -B build
 * -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` — ONLY when the project declares no
 * preset (a declared preset is the author's build contract; this op never
 * overrides it, and never rewrites any build file).
 */
export async function configureConventional(
  from: string = getCwd(),
  opts?: { timeoutMs?: number },
): Promise<CppBuildRun> {
  const profile = buildCppProjectProfile(from)
  // Preset check FIRST — deterministic on cmake-less machines.
  const listing = listCMakePresets(from)
  if (listing.configurePresets.length > 0) {
    return refusal(
      'configure-conventional',
      `the project declares configure preset(s) (${listing.configurePresets.map(p => p.name).join(', ')}) — use configurePreset; the conventional remedy is only for preset-less projects`,
    )
  }
  if (listing.state === 'error') {
    return refusal('configure-conventional', `presets file exists but did not parse — fix it first (${listing.detail})`)
  }
  if (!profile.cmake.lists) {
    return refusal('configure-conventional', 'no CMakeLists.txt — nothing for cmake to configure here')
  }
  const cmakePath = probeCmake()
  if (!cmakePath) return refusal('configure-conventional', CMAKE_REMEDY)
  return runCmake({
    op: 'configure-conventional',
    cmakePath,
    args: ['-B', 'build', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'],
    cwd: profile.projectRoot,
    from,
    expectDbDir: path.join(profile.projectRoot, 'build'),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
}

function firstConfiguredBuildDir(profile: CppProjectProfile): string | undefined {
  return profile.buildDirs.find(d => d.configured)?.path
}

/** `cmake --build` — a build preset when given, else the configured build dir. */
export async function buildTarget(
  options: { target?: string; preset?: string; from?: string; timeoutMs?: number } = {},
): Promise<CppBuildRun> {
  const from = options.from ?? getCwd()
  const profile = buildCppProjectProfile(from)
  const targetArgs = options.target ? ['--target', options.target] : []
  if (options.preset) {
    const listing = listCMakePresets(from)
    if (!listing.buildPresets.includes(options.preset)) {
      return refusal(
        'build',
        listing.buildPresets.length
          ? `unknown build preset '${options.preset}' — declared: ${listing.buildPresets.join(', ')}`
          : `no build presets declared — build via the configured dir (omit preset)`,
      )
    }
    const cmakePath = probeCmake()
    if (!cmakePath) return refusal('build', CMAKE_REMEDY)
    return runCmake({
      op: 'build',
      cmakePath,
      args: ['--build', '--preset', options.preset, ...targetArgs],
      cwd: profile.projectRoot,
      from,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
  }
  // Build-dir resolution FIRST — deterministic on cmake-less machines.
  const buildDir = firstConfiguredBuildDir(profile)
  if (!buildDir) {
    return refusal(
      'build',
      'no configured build directory (no CMakeCache.txt found) — run configurePreset/configureConventional first',
    )
  }
  const cmakePath = probeCmake()
  if (!cmakePath) return refusal('build', CMAKE_REMEDY)
  return runCmake({
    op: 'build',
    cmakePath,
    args: ['--build', buildDir, ...targetArgs],
    cwd: profile.projectRoot,
    from,
    expectDbDir: buildDir,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
}

/** Clean through the build system's OWN clean target (`cmake --build <dir>
 *  --target clean`) — never a recursive delete, never a build-file rewrite. */
export async function clean(
  profile: CppProjectProfile,
  opts?: { timeoutMs?: number },
): Promise<CppBuildRun> {
  const buildDir = firstConfiguredBuildDir(profile)
  if (!buildDir) {
    return refusal('clean', 'no configured build directory — nothing to clean (this op never deletes paths itself)')
  }
  const cmakePath = probeCmake()
  if (!cmakePath) return refusal('clean', CMAKE_REMEDY)
  return runCmake({
    op: 'clean',
    cmakePath,
    args: ['--build', buildDir, '--target', 'clean'],
    cwd: profile.projectRoot,
    from: profile.projectRoot,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
}
