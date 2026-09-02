
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { compileDbRemedy, probeCompileDb } from '../lsp/clangdLane.js'

export type CompileDbSource = 'root' | 'build-dir' | 'compile-flags' | 'clangd-config'

export type CppCompileDb =
  | { state: 'ok'; path: string; source: CompileDbSource }
  | { state: 'absent'; remedy: string }

export interface CppCmakePreset {
  name: string
  displayName?: string
  binaryDir?: string
}

export interface CppBuildDirInfo {
  path: string
  configured: boolean
  compileDb: boolean
  generator?: 'ninja' | 'make'
}

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
  markers: string[]
  compileDb: CppCompileDb
  clangd: { configured: boolean; evidence?: string }
  clangTidy: { configured: boolean; evidence?: string }
  clangFormat: { configured: boolean; evidence?: string }
  cmake: {
    lists?: string
    presetsFile?: string
    presets: CppCmakePreset[]
    buildPresets: string[]
    presetsError?: string
  }
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


function classifyCompileDb(dbPath: string): CompileDbSource {
  const base = path.basename(dbPath)
  if (base === 'compile_flags.txt') return 'compile-flags'
  if (base === '.clangd') return 'clangd-config'
  return path.basename(path.dirname(dbPath)) === 'build' ? 'build-dir' : 'root'
}

export function cppCompileDbVerdict(from: string = getCwd()): CppCompileDb {
  const probe = probeCompileDb(from)
  if (probe.compileDb) {
    return { state: 'ok', path: probe.compileDb, source: classifyCompileDb(probe.compileDb) }
  }
  return { state: 'absent', remedy: compileDbRemedy(probe) }
}


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
  }
  for (const p of presets) {
    if (p.binaryDir && !p.binaryDir.includes('${') && existsSync(p.binaryDir)) push(p.binaryDir)
  }
  return dirs
}


let profileCache: { at: number; key: string; profile: CppProjectProfile } | null = null

function profileKey(root: string, from: string): string {
  return [root, path.resolve(from), process.env.PATH ?? ''].join('\0')
}

export function _resetCppProjectForTesting(): void {
  profileCache = null
}

export function buildCppProjectProfile(from: string = getCwd()): CppProjectProfile {
  const { root, markers } = findCppProjectRoot(from)
  const key = profileKey(root, from)
  if (profileCache && profileCache.key === key && Date.now() - profileCache.at < CACHE_TTL_MS) {
    return profileCache.profile
  }

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
