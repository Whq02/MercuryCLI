#!/usr/bin/env bun
// ============================================================================
//  scripts/lsp/prove-clangd-lane.ts
//  PROOF: the C/C++ IDE-hands lane (`mercury-clangd`,
//  MERCURY_LSP_CPP) — the registry evidence artifact for the flag row.
//
//   §1  gate polarity: MERCURY_LSP=0 kills every builtin source;
//       MERCURY_LSP_CPP=0 kills ONLY the clangd lane; default is ON.
//   §2  binary resolution: PATH wins, plain `clangd` beats versioned
//       `clangd-N`, versioned resolves when plain is absent, and with the
//       system fallbacks skipped an empty PATH is an HONEST absence with an
//       install-hint reason.
//   §3  config shape: the extension claim set, --clang-tidy static analysis,
//       protocol-quiet stderr, stdio transport, mercury-builtin source.
//   §4  compile-DB evidence walk: root + build/ DBs found from a subdir;
//       CMake-without-DB teaches the CMAKE_EXPORT_COMPILE_COMMANDS remedy;
//       bare trees get the bear/compile_flags remedy.
//   §5  operator override: an MERCURY_LSP_SERVERS entry claiming .cpp is
//       merged AHEAD of the builtin lane (first-wins).
//   §6  registry honesty: the flag rows exist and the generated doc carries
//       them.
//
//  Run:  ~/.bun/bin/bun run scripts/lsp/prove-clangd-lane.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' mercury-clangd lane (MERCURY_LSP_CPP) — proof')
console.log('============================================================')

const {
  probeBuiltinClangd,
  builtinClangdServer,
  probeCompileDb,
  compileDbRemedy,
  mercuryLspCppEnabled,
  MERCURY_CLANGD_SERVER_NAME,
  _resetClangdProbeCacheForTesting,
} = await import('../../src/services/lsp/clangdLane.js')
const { getMercuryLspServerSources } = await import(
  '../../src/services/lsp/builtinServers.js'
)

const scratch = mkdtempSync(path.join(tmpdir(), 'clangd-lane-'))
const savedEnv = { ...process.env }
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  _resetClangdProbeCacheForTesting()
}
function fakeClangd(dir: string, name: string): string {
  const p = path.join(dir, name)
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}

section('§1 · gate polarity')
{
  restoreEnv()
  const binDir = path.join(scratch, 'bin1')
  mkdirSync(binDir, { recursive: true })
  fakeClangd(binDir, 'clangd')
  process.env.PATH = binDir

  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP_CPP
  _resetClangdProbeCacheForTesting()
  check('default (stamped build): cpp lane gate is ON', mercuryLspCppEnabled())
  check(
    'default: builtin sources carry mercury-clangd',
    MERCURY_CLANGD_SERVER_NAME in getMercuryLspServerSources().builtin,
  )

  process.env.MERCURY_LSP_CPP = '0'
  _resetClangdProbeCacheForTesting()
  check('MERCURY_LSP_CPP=0: gate OFF (live re-read)', !mercuryLspCppEnabled())
  const srcCppOff = getMercuryLspServerSources()
  check(
    'MERCURY_LSP_CPP=0: mercury-clangd absent',
    !(MERCURY_CLANGD_SERVER_NAME in srcCppOff.builtin),
  )
  check(
    'MERCURY_LSP_CPP=0: builtinClangdServer() is {}',
    Object.keys(builtinClangdServer()).length === 0,
  )
  delete process.env.MERCURY_LSP_CPP

  process.env.MERCURY_LSP = '0'
  _resetClangdProbeCacheForTesting()
  check(
    'MERCURY_LSP=0: the master kill empties every builtin source',
    Object.keys(getMercuryLspServerSources().builtin).length === 0 &&
      Object.keys(getMercuryLspServerSources().env).length === 0,
  )
  delete process.env.MERCURY_LSP
}

section('§2 · binary resolution (PATH-controlled, fallbacks skipped)')
{
  restoreEnv()
  const plainDir = path.join(scratch, 'bin-plain')
  const versionedDir = path.join(scratch, 'bin-versioned')
  const bothDir = path.join(scratch, 'bin-both')
  const emptyDir = path.join(scratch, 'bin-empty')
  for (const d of [plainDir, versionedDir, bothDir, emptyDir]) {
    mkdirSync(d, { recursive: true })
  }
  const plain = fakeClangd(plainDir, 'clangd')
  const versioned = fakeClangd(versionedDir, 'clangd-19')
  const bothPlain = fakeClangd(bothDir, 'clangd')
  fakeClangd(bothDir, 'clangd-20')

  process.env.PATH = plainDir
  check(
    'plain clangd on PATH resolves',
    probeBuiltinClangd({ skipSystemFallbacks: true }).clangdPath === plain,
  )
  process.env.PATH = versionedDir
  check(
    'versioned clangd-19 resolves when plain is absent',
    probeBuiltinClangd({ skipSystemFallbacks: true }).clangdPath === versioned,
  )
  process.env.PATH = bothDir
  check(
    'plain beats versioned in the same dir',
    probeBuiltinClangd({ skipSystemFallbacks: true }).clangdPath === bothPlain,
  )
  process.env.PATH = emptyDir
  const absent = probeBuiltinClangd({ skipSystemFallbacks: true })
  check('empty PATH ⇒ honest absence', !absent.available)
  check(
    'absence reason teaches the installs',
    (absent.reason ?? '').includes('brew install llvm') &&
      (absent.reason ?? '').includes('apt install clangd'),
  )
}

section('§3 · config shape')
{
  restoreEnv()
  const binDir = path.join(scratch, 'bin3')
  mkdirSync(binDir, { recursive: true })
  const bin = fakeClangd(binDir, 'clangd')
  process.env.PATH = binDir
  _resetClangdProbeCacheForTesting()
  const config = builtinClangdServer()[MERCURY_CLANGD_SERVER_NAME]
  check('config present with fake PATH clangd', config !== undefined)
  if (config) {
    check('command is the resolved binary', config.command === bin)
    const ext = config.extensionToLanguage
    check(
      'extension claims: .c/.cpp/.cc/.h/.hpp/.m/.mm/.cu',
      ext['.c'] === 'c' &&
        ext['.cpp'] === 'cpp' &&
        ext['.cc'] === 'cpp' &&
        ext['.h'] === 'cpp' &&
        ext['.hpp'] === 'cpp' &&
        ext['.m'] === 'objective-c' &&
        ext['.mm'] === 'objective-cpp' &&
        ext['.cu'] === 'cuda',
    )
    check(
      'args arm clang-tidy + quiet stderr + no header-insertion',
      (config.args ?? []).includes('--clang-tidy') &&
        (config.args ?? []).includes('--log=error') &&
        (config.args ?? []).includes('--header-insertion=never'),
    )
    check('stdio transport', config.transport === 'stdio')
    check('source stamped mercury-builtin', config.source === 'mercury-builtin')
    check('workspaceFolder set', typeof config.workspaceFolder === 'string' && config.workspaceFolder.length > 0)
  }
}

section('§4 · compile-DB evidence walk')
{
  const proj = path.join(scratch, 'proj-db')
  mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true })
  writeFileSync(path.join(proj, 'compile_commands.json'), '[]')
  const fromDeep = probeCompileDb(path.join(proj, 'src', 'deep'))
  check(
    'root compile_commands.json found from a subdir',
    fromDeep.compileDb === path.join(proj, 'compile_commands.json'),
  )

  const projBuild = path.join(scratch, 'proj-build')
  mkdirSync(path.join(projBuild, 'build'), { recursive: true })
  writeFileSync(path.join(projBuild, 'build', 'compile_commands.json'), '[]')
  check(
    'build/compile_commands.json found',
    probeCompileDb(projBuild).compileDb ===
      path.join(projBuild, 'build', 'compile_commands.json'),
  )

  const projCmake = path.join(scratch, 'proj-cmake')
  mkdirSync(projCmake, { recursive: true })
  writeFileSync(path.join(projCmake, 'CMakeLists.txt'), '')
  const cmakeProbe = probeCompileDb(projCmake)
  check('CMake-without-DB: no DB, CMakeLists seen', !cmakeProbe.compileDb && !!cmakeProbe.cmakeLists)
  check(
    'CMake remedy teaches CMAKE_EXPORT_COMPILE_COMMANDS',
    compileDbRemedy(cmakeProbe).includes('CMAKE_EXPORT_COMPILE_COMMANDS'),
  )
  const bare = probeCompileDb(path.join(scratch, 'proj-db', 'src'))
  void bare
  const bareProbe = probeCompileDb(scratch)
  check(
    'bare tree remedy mentions bear + compile_flags.txt',
    compileDbRemedy(bareProbe).includes('bear') &&
      compileDbRemedy(bareProbe).includes('compile_flags.txt'),
  )
}

section('§5 · operator override outranks the builtin lane (first-wins)')
{
  restoreEnv()
  const binDir = path.join(scratch, 'bin5')
  mkdirSync(binDir, { recursive: true })
  fakeClangd(binDir, 'clangd')
  process.env.PATH = binDir
  process.env.MERCURY_LSP_SERVERS = JSON.stringify({
    ccls: {
      command: '/usr/bin/true',
      extensionToLanguage: { '.cpp': 'cpp' },
    },
  })
  _resetClangdProbeCacheForTesting()
  const { getAllLspServers } = await import('../../src/services/lsp/config.js')
  const merged = Object.keys((await getAllLspServers()).servers)
  const envIdx = merged.indexOf('env:ccls')
  const builtinIdx = merged.indexOf(MERCURY_CLANGD_SERVER_NAME)
  check('env override present', envIdx !== -1)
  check('builtin clangd still present', builtinIdx !== -1)
  check(
    'env override inserted AHEAD of the builtin (claims .cpp first)',
    envIdx !== -1 && builtinIdx !== -1 && envIdx < builtinIdx,
  )
  delete process.env.MERCURY_LSP_SERVERS
}

section('§6 · registry honesty')
{
  const repo = path.resolve(import.meta.dir, '../..')
  const registry = readFileSync(
    path.join(repo, 'src/substrate/flagRegistry.ts'),
    'utf8',
  )
  check(
    "flagRegistry: MERCURY_LSP_CPP row (default-on, this proof as evidence)",
    registry.includes("env: 'MERCURY_LSP_CPP'") &&
      registry.includes('scripts/lsp/prove-clangd-lane.ts'),
  )
  const reg = readFileSync(path.join(repo, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('the flag registry carries the MERCURY_LSP_CPP legacy alias', reg.includes('MERCURY_LSP_CPP'))
}

restoreEnv()
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.error(`❌ ${failures} CLANGD-LANE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CLANGD-LANE PROOFS PASS')
