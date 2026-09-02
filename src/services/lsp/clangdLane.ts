
import { execFileSync } from 'node:child_process'
import { languageServerEnv } from '../../utils/subprocessEnv.js'
import { accessSync, constants, existsSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { ScopedLspServerConfig } from './types.js'

export const MERCURY_CLANGD_SERVER_NAME = 'mercury-clangd'

const VERSIONED_CLANGD_NAMES = Array.from(
  { length: 10 },
  (_, i) => `clangd-${22 - i}`,
)

const CPP_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.c': 'c',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
  '.inl': 'cpp',
  '.ipp': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',
  '.cu': 'cuda',
  '.cuh': 'cuda',
}

export function mercuryLspCppEnabled(): boolean {
  return mercuryLspEnabled() && flagEnabled('MERCURY_LSP_CPP')
}

function isExecutable(p: string): boolean {
  try {
    if (process.platform === 'win32') return existsSync(p)
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(names: string[]): string | undefined {
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const name of names) {
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix)
        if (isExecutable(candidate)) return candidate
      }
    }
  }
  return undefined
}

function xcrunFindClangd(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const out = execFileSync('xcrun', ['--find', 'clangd'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...languageServerEnv() },
    }).trim()
    return out && isExecutable(out) ? out : undefined
  } catch {
    return undefined
  }
}

const BREW_LLVM_CANDIDATES = [
  '/opt/homebrew/opt/llvm/bin/clangd',
  '/usr/local/opt/llvm/bin/clangd',
]

export interface ClangdProbe {
  available: boolean
  clangdPath?: string
  reason?: string
}

let probeCache: { at: number; result: ClangdProbe } | undefined
const PROBE_CACHE_TTL_MS = 30_000

export function probeBuiltinClangd(testOpts?: {
  skipSystemFallbacks?: boolean
}): ClangdProbe {
  const now = Date.now()
  if (!testOpts && probeCache && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result
  }
  const resolved =
    findOnPath(['clangd', ...VERSIONED_CLANGD_NAMES]) ??
    (testOpts?.skipSystemFallbacks
      ? undefined
      : (xcrunFindClangd() ?? BREW_LLVM_CANDIDATES.find(isExecutable)))
  const result: ClangdProbe = resolved
    ? { available: true, clangdPath: resolved }
    : {
        available: false,
        reason:
          'no clangd on PATH (install: xcode-select --install · brew install llvm · apt install clangd)',
      }
  if (!testOpts) probeCache = { at: now, result }
  return result
}

export function _resetClangdProbeCacheForTesting(): void {
  probeCache = undefined
}

export interface CompileDbProbe {
  compileDb?: string
  cmakeLists?: string
}

const COMPILE_DB_WALK_LIMIT = 12

export function probeCompileDb(from: string = getCwd()): CompileDbProbe {
  let dir = path.resolve(from)
  let cmakeLists: string | undefined
  for (let depth = 0; depth < COMPILE_DB_WALK_LIMIT; depth++) {
    for (const rel of [
      'compile_commands.json',
      path.join('build', 'compile_commands.json'),
      'compile_flags.txt',
      '.clangd',
    ]) {
      const candidate = path.join(dir, rel)
      if (existsSync(candidate)) return { compileDb: candidate, cmakeLists }
    }
    if (!cmakeLists && existsSync(path.join(dir, 'CMakeLists.txt'))) {
      cmakeLists = path.join(dir, 'CMakeLists.txt')
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { cmakeLists }
}

export function compileDbRemedy(probe: CompileDbProbe): string {
  return probe.cmakeLists
    ? 'no compile_commands.json — generate one: cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON (clangd runs on fallback flags until then)'
    : 'no compile_commands.json — clangd runs on fallback flags (cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON, `bear -- make`, or a compile_flags.txt give it real flags)'
}

export function builtinClangdServer(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspCppEnabled()) return {}
  const probe = probeBuiltinClangd()
  if (!probe.available || !probe.clangdPath) {
    logForDebugging(
      `[LSP BUILTIN] mercury-clangd unavailable: ${probe.reason ?? 'unknown'}`,
    )
    return {}
  }
  return {
    [MERCURY_CLANGD_SERVER_NAME]: {
      command: probe.clangdPath,
      args: ['--clang-tidy', '--header-insertion=never', '--log=error'],
      extensionToLanguage: { ...CPP_EXTENSION_TO_LANGUAGE },
      transport: 'stdio',
      workspaceFolder: getCwd(),
      startupTimeout: 30_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}
