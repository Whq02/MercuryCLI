// clangdLane — the C/C++ IDE-hands lane (`mercury-clangd`, MERCURY_LSP_CPP).
//
// The C++ IDE table-stakes (navigation, refactoring, static analysis,
// build-system awareness) all reduce to ONE server done right: clangd.
// Registration is binary-gated, not project-gated — clangd needs nothing
// from the workspace (it degrades gracefully without a compilation
// database), servers lazy-start on first file touch, and a monorepo's
// native/ subtree must get the lane even when the repo ROOT shows no C++
// marker. Bloat contract: in a repo where no C/C++ file is ever touched the
// registered config is one idle map entry — no process, no prompt bytes.
//
//   · default-ON under the IDE-hands bridge (MERCURY_LSP); MERCURY_LSP_CPP=0
//     removes just this lane (default-on, registered in flagRegistry).
//   · binary resolution, most-specific first: PATH (`clangd`, then versioned
//     `clangd-N` newest-first) → darwin `xcrun --find clangd` → Homebrew
//     llvm kegs. Cached 30s (the sidecar's tsconfig negative-cache idiom) so
//     repeated probes stay cheap but a mid-session install is picked up.
//   · --clang-tidy arms static analysis (diagnostics carry tidy checks when
//     the project configures them); --log=error keeps the protocol stderr
//     quiet; --header-insertion=never because agents write includes as
//     edits, not via completion side-effects.
//   · compile-DB awareness is EVIDENCE, not gating: probeCompileDb walks up
//     from cwd and the /health lsp row teaches the cmake/bear remedy when a
//     C++ project has no compile_commands.json.
//
// Proof: scripts/lsp/prove-clangd-lane.ts (gating polarity, resolution
// order, config shape, compile-DB evidence).

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

/** Newest-first versioned names Linux distros install without a plain alias. */
const VERSIONED_CLANGD_NAMES = Array.from(
  { length: 10 },
  (_, i) => `clangd-${22 - i}`, // clangd-22 … clangd-13
)

const CPP_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.c': 'c',
  // .h defaults to 'cpp' (the VS Code convention): clangd decides the real
  // language from the compilation database; the languageId is only a hint,
  // and C++ headers dominate mixed trees.
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

/** Lane gate: rides the IDE-hands master, `MERCURY_LSP_CPP=0` opts out. */
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

// 30s cache: probes run at manager init/reinit and from /health; the binary
// set is stable within a session but a mid-session `brew install llvm`
// becomes visible without a restart (the sidecar's negative-cache idiom).
let probeCache: { at: number; result: ClangdProbe } | undefined
const PROBE_CACHE_TTL_MS = 30_000

/**
 * Availability probe for the clangd lane — shared by the config source and
 * the /health `lsp` check, so the doctor's evidence line and the boot
 * decision can never disagree.
 *
 * @param testOpts test-only (scripts/lsp/prove-clangd-lane.ts): skip the
 *   xcrun/Homebrew system fallbacks so PATH fully controls resolution on any
 *   machine, and bypass the cache. Production callers pass nothing.
 */
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

/** Test-only: drop the probe cache so gating proofs see fresh env/PATH. */
export function _resetClangdProbeCacheForTesting(): void {
  probeCache = undefined
}

export interface CompileDbProbe {
  /** Absolute path of the compilation database that will drive clangd, if any. */
  compileDb?: string
  /** Nearest CMakeLists.txt when no DB exists — powers the doctor remedy line. */
  cmakeLists?: string
}

const COMPILE_DB_WALK_LIMIT = 12

/**
 * Walk up from `from` looking for what clangd will actually use: a
 * compile_commands.json (root or build/), compile_flags.txt, or a .clangd
 * config. Pure evidence — registration never depends on it.
 */
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

/** The remedy line /health teaches when a C++ project runs without a DB. */
export function compileDbRemedy(probe: CompileDbProbe): string {
  return probe.cmakeLists
    ? 'no compile_commands.json — generate one: cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON (clangd runs on fallback flags until then)'
    : 'no compile_commands.json — clangd runs on fallback flags (cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON, `bear -- make`, or a compile_flags.txt give it real flags)'
}

/** The builtin `mercury-clangd` server source (empty when gated off or no binary). */
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
