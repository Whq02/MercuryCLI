// ============================================================================
//  ide/cppProject — ONE owner for C/C++ project truth.
//  Modeled on pythonProject.ts (the slice-2 house idiom): probed truth,
//  marker evidence, bounded caches with env-keyed invalidation, _reset seams.
//
//  What it owns:
//    · project-root detection (nearest C/C++-marker directory);
//    · the compilation-database VERDICT — which database clangd is ACTUALLY
//      using. The clangd lane (services/lsp/clangdLane.ts) registers NO
//      --compile-commands-dir, so the truth IS probeCompileDb's walk result
//      (root compile_commands.json → build/compile_commands.json →
//      compile_flags.txt → .clangd, nearest directory first). This module
//      REUSES that probe — never a second walk implementation — and, when
//      nothing is found, carries compileDbRemedy's exact teaching line;
//    · CMake awareness: CMakeLists.txt, CMakePresets.json (+ user presets)
//      with the preset NAMES parsed (malformed JSON surfaces typed, never
//      throws);
//    · candidate build directories (bounded root scan + preset binaryDirs)
//      with generator evidence (build.ninja / Makefile / CMakeCache.txt);
//    · format/tidy configuration evidence (.clang-format, .clang-tidy) and
//      .clangd config presence — a .clangd CompileFlags/CompilationDatabase
//      section can OVERRIDE the walk verdict inside clangd itself, so its
//      presence is surfaced beside the verdict rather than silently folded in.
//
//  Everything here is EVIDENCE, never a readiness claim — journeys prove
//  readiness (the clangd lane stays binary-gated and project-independent).
//  Build OPERATIONS live beside this in cppBuild.ts. The lead wires the
//  mercury://ide/cpp/project resource at integration (this module stays
//  adapter-free by slice contract).
//
//  Proof: scripts/ide/prove-cpp-project.ts.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { compileDbRemedy, probeCompileDb } from '../lsp/clangdLane.js'

export type CompileDbSource = 'root' | 'build-dir' | 'compile-flags' | 'clangd-config'

/**
 * The database clangd will ACTUALLY use. `ok` carries the walk winner and
 * which precedence rung it is; `absent` carries the exact /doctor remedy line
 * (compileDbRemedy — cmake when a CMakeLists exists, the generic ladder
 * otherwise).
 */
export type CppCompileDb =
  | { state: 'ok'; path: string; source: CompileDbSource }
  | { state: 'absent'; remedy: string }

export interface CppCmakePreset {
  name: string
  displayName?: string
  /** binaryDir with ${sourceDir}/${presetName} expanded (other macros kept verbatim). */
  binaryDir?: string
}

export interface CppBuildDirInfo {
  path: string
  /** cmake has configured this dir (CMakeCache.txt present). */
  configured: boolean
  /** the dir carries its own compile_commands.json. */
  compileDb: boolean
  generator?: 'ninja' | 'make'
}

// The build primitives (configure/build/clean over CMake presets) are part
// of this lane's public face — re-exported here so consumers reach the whole
// C/C++ project surface through ONE module (the launch profiles and
// the build closed loop consume these).
export {
  listCMakePresets,
  configurePreset,
  configureConventional,
  buildTarget,
  clean,
  type CppBuildRun,
} from './cppBuild.js'

export interface CppProjectProfile {
  projectRoot: string
  /** Marker files found at the root (evidence for root detection). */
  markers: string[]
  /**
   * The compilation database clangd is ACTUALLY using. Truth = the
   * probeCompileDb walk (the lane passes no --compile-commands-dir); a
   * present .clangd config (see `clangd`) can override this inside clangd
   * via CompileFlags/CompilationDatabase — surfaced, not second-guessed.
   */
  compileDb: CppCompileDb
  /** .clangd config presence — can override the compileDb verdict. */
  clangd: { configured: boolean; evidence?: string }
  clangTidy: { configured: boolean; evidence?: string }
  clangFormat: { configured: boolean; evidence?: string }
  cmake: {
    /** Nearest CMakeLists.txt (root file or the walk's remedy evidence). */
    lists?: string
    presetsFile?: string
    /** Non-hidden configure presets, in file order (user presets appended). */
    presets: CppCmakePreset[]
    /** Non-hidden build preset names (cmake --build --preset targets). */
    buildPresets: string[]
    /** Malformed presets JSON — typed, never thrown. */
    presetsError?: string
  }
  /** Candidate build directories (bounded: conventional names + preset binaryDirs). */
  buildDirs: CppBuildDirInfo[]
  buildSystem: { ninja: boolean; make: boolean }
  collectedAt: number
}

const CACHE_TTL_MS = 30_000
const ROOT_WALK_LIMIT = 12
const PRESETS_FILE_MAX_BYTES = 512 * 1024
const BUILD_DIR_SCAN_MAX = 8

const CPP_PROJECT_MARKERS = [
  'CMakeLists.txt',
  'CMakePresets.json',
  'compile_commands.json',
  'compile_flags.txt',
  '.clangd',
  'Makefile',
  'meson.build',
] as const

// ── project root ─────────────────────────────────────────────────────────────

/** Nearest ancestor carrying a C/C++ project marker; falls back to `from`
 *  itself — a bare directory is still a workable root. */
export function findCppProjectRoot(from: string = getCwd()): { root: string; markers: string[] } {
  let dir = path.resolve(from)
  for (let depth = 0; depth < ROOT_WALK_LIMIT; depth++) {
    const markers = CPP_PROJECT_MARKERS.filter(m => existsSync(path.join(dir, m)))
    if (markers.length > 0) return { root: dir, markers: [...markers] }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { root: path.resolve(from), markers: [] }
}

// ── compile-DB verdict (REUSES the lane's walk — never a second one) ─────────

function classifyCompileDb(dbPath: string): CompileDbSource {
  const base = path.basename(dbPath)
  if (base === 'compile_flags.txt') return 'compile-flags'
  if (base === '.clangd') return 'clangd-config'
  return path.basename(path.dirname(dbPath)) === 'build' ? 'build-dir' : 'root'
}

/** The clangd compile-DB verdict for `from` — probeCompileDb's walk result,
 *  classified; absent carries compileDbRemedy's exact line. */
export function cppCompileDbVerdict(from: string = getCwd()): CppCompileDb {
  const probe = probeCompileDb(from)
  if (probe.compileDb) {
    return { state: 'ok', path: probe.compileDb, source: classifyCompileDb(probe.compileDb) }
  }
  return { state: 'absent', remedy: compileDbRemedy(probe) }
}

// ── CMakePresets parsing ─────────────────────────────────────────────────────

interface RawPreset {
  name?: unknown
  hidden?: unknown
  displayName?: unknown
  binaryDir?: unknown
}

function expandPresetMacros(value: string, root: string, presetName: string): string {
  return value
    .replaceAll('${sourceDir}', root)
    .replaceAll('${presetName}', presetName)
}

function readPresetFile(
  file: string,
  root: string,
): { configure: CppCmakePreset[]; build: string[] } | { error: string } {
  try {
    if (statSync(file).size > PRESETS_FILE_MAX_BYTES) {
      return { error: `${path.basename(file)} exceeds ${PRESETS_FILE_MAX_BYTES} bytes — not parsed` }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      configurePresets?: RawPreset[]
      buildPresets?: RawPreset[]
    }
    const configure: CppCmakePreset[] = []
    for (const p of Array.isArray(parsed.configurePresets) ? parsed.configurePresets : []) {
      if (typeof p?.name !== 'string' || p.hidden === true) continue
      configure.push({
        name: p.name,
        ...(typeof p.displayName === 'string' ? { displayName: p.displayName } : {}),
        ...(typeof p.binaryDir === 'string'
          ? { binaryDir: expandPresetMacros(p.binaryDir, root, p.name) }
          : {}),
      })
    }
    const build = (Array.isArray(parsed.buildPresets) ? parsed.buildPresets : [])
      .filter(p => typeof p?.name === 'string' && p.hidden !== true)
      .map(p => p.name as string)
    return { configure, build }
  } catch (e) {
    return { error: `${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Parse CMakePresets.json (+ CMakeUserPresets.json appended) at `root`.
 *  Malformed JSON is a typed error, never a throw — the profile stays usable. */
export function parseCMakePresets(root: string): {
  presetsFile?: string
  presets: CppCmakePreset[]
  buildPresets: string[]
  presetsError?: string
} {
  const presets: CppCmakePreset[] = []
  const buildPresets: string[] = []
  let presetsFile: string | undefined
  let presetsError: string | undefined
  for (const name of ['CMakePresets.json', 'CMakeUserPresets.json']) {
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    presetsFile ??= file
    const parsed = readPresetFile(file, root)
    if ('error' in parsed) {
      presetsError = presetsError ? `${presetsError}; ${parsed.error}` : parsed.error
      continue
    }
    for (const p of parsed.configure) {
      if (!presets.some(existing => existing.name === p.name)) presets.push(p)
    }
    for (const b of parsed.build) {
      if (!buildPresets.includes(b)) buildPresets.push(b)
    }
  }
  return {
    ...(presetsFile ? { presetsFile } : {}),
    presets,
    buildPresets,
    ...(presetsError ? { presetsError } : {}),
  }
}

// ── build-directory candidates ───────────────────────────────────────────────

const BUILD_DIR_NAME = /^(build|out|_build|cmake-build-)/i

function buildDirInfo(dir: string): CppBuildDirInfo {
  const ninja = existsSync(path.join(dir, 'build.ninja'))
  const make = existsSync(path.join(dir, 'Makefile'))
  return {
    path: dir,
    configured: existsSync(path.join(dir, 'CMakeCache.txt')),
    compileDb: existsSync(path.join(dir, 'compile_commands.json')),
    ...(ninja ? { generator: 'ninja' as const } : make ? { generator: 'make' as const } : {}),
  }
}

/** Candidate build dirs: conventional names at the root (bounded scan) plus
 *  any preset binaryDir that exists on disk. */
export function findCppBuildDirs(root: string, presets: CppCmakePreset[]): CppBuildDirInfo[] {
  const seen = new Set<string>()
  const dirs: CppBuildDirInfo[] = []
  const push = (dir: string): void => {
    const abs = path.resolve(dir)
    if (seen.has(abs) || dirs.length >= BUILD_DIR_SCAN_MAX) return
    seen.add(abs)
    dirs.push(buildDirInfo(abs))
  }
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && BUILD_DIR_NAME.test(entry.name)) push(path.join(root, entry.name))
    }
  } catch {
    /* unreadable root — preset dirs below may still resolve */
  }
  for (const p of presets) {
    // Unexpanded macros (${env:…}) make the path speculative — skip those.
    if (p.binaryDir && !p.binaryDir.includes('${') && existsSync(p.binaryDir)) push(p.binaryDir)
  }
  return dirs
}

// ── the full profile (cached) ────────────────────────────────────────────────

let profileCache: { at: number; key: string; profile: CppProjectProfile } | null = null

// Env-keyed like the Python owner: PATH shifts what the sibling build ops can
// probe (cmake), so a PATH change invalidates rather than waiting out the TTL.
// `from` joins the key because the compile-DB verdict walks from THERE (a
// monorepo subtree may see a different DB than the root does).
function profileKey(root: string, from: string): string {
  return [root, path.resolve(from), process.env.PATH ?? ''].join('\0')
}

/** TEST-ONLY: drop the profile cache (fixture proofs re-read fresh dirs). */
export function _resetCppProjectForTesting(): void {
  profileCache = null
}

/** Build the full C/C++ project profile. Marker/coordinate EVIDENCE, plus the
 *  compile-DB verdict clangd actually operates under. Cached 30s, env-keyed. */
export function buildCppProjectProfile(from: string = getCwd()): CppProjectProfile {
  const { root, markers } = findCppProjectRoot(from)
  const key = profileKey(root, from)
  if (profileCache && profileCache.key === key && Date.now() - profileCache.at < CACHE_TTL_MS) {
    return profileCache.profile
  }

  // The verdict walks from `from` (not the detected root): that is exactly
  // what clangd sees for a file opened under `from` in a monorepo subtree.
  const compileDb = cppCompileDbVerdict(from)
  const walk = probeCompileDb(from)

  const clangdFile = path.join(root, '.clangd')
  const tidyFile = path.join(root, '.clang-tidy')
  const formatFile = path.join(root, '.clang-format')
  const lists = existsSync(path.join(root, 'CMakeLists.txt'))
    ? path.join(root, 'CMakeLists.txt')
    : walk.cmakeLists

  const presetInfo = parseCMakePresets(root)
  const buildDirs = findCppBuildDirs(root, presetInfo.presets)

  const profile: CppProjectProfile = {
    projectRoot: root,
    markers,
    compileDb,
    clangd: { configured: existsSync(clangdFile), ...(existsSync(clangdFile) ? { evidence: '.clangd' } : {}) },
    clangTidy: { configured: existsSync(tidyFile), ...(existsSync(tidyFile) ? { evidence: '.clang-tidy' } : {}) },
    clangFormat: {
      configured: existsSync(formatFile),
      ...(existsSync(formatFile) ? { evidence: '.clang-format' } : {}),
    },
    cmake: {
      ...(lists ? { lists } : {}),
      ...presetInfo,
    },
    buildDirs,
    buildSystem: {
      ninja: buildDirs.some(d => d.generator === 'ninja'),
      make: buildDirs.some(d => d.generator === 'make') || existsSync(path.join(root, 'Makefile')),
    },
    collectedAt: Date.now(),
  }
  profileCache = { at: Date.now(), key, profile }
  return profile
}
