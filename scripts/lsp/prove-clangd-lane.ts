#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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
} = await import('../../src/integrations/lsp/clangdLane.js')
const { getMercuryLspServerSources } = await import(
  '../../src/integrations/lsp/builtinServers.js'
)
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.js')

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
  const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name)
  writeFileSync(p, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n')
  if (process.platform !== 'win32') chmodSync(p, 0o755)
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
  check('default (stamped build): cpp lane gate is ON', mercuryLspCppEnabled(), 'mercuryLspCppEnabled in src/integrations/lsp/clangdLane.ts must be true when neither MERCURY_LSP nor MERCURY_LSP_CPP is set; check the MERCURY_LSP_CPP default-on row in FLAG_REGISTRY')
  check(
    'default: builtin sources carry mercury-clangd',
    MERCURY_CLANGD_SERVER_NAME in getMercuryLspServerSources().builtin,
    'getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must spread builtinClangdServer() into builtin; builtinClangdServer in src/integrations/lsp/clangdLane.ts returns {} when the gate is off or no clangd is found',
  )

  process.env.MERCURY_LSP_CPP = '0'
  _resetClangdProbeCacheForTesting()
  check('MERCURY_LSP_CPP=0: gate OFF (live re-read)', !mercuryLspCppEnabled(), 'mercuryLspCppEnabled in src/integrations/lsp/clangdLane.ts must read MERCURY_LSP_CPP on every call, not cache it')
  const srcCppOff = getMercuryLspServerSources()
  check(
    'MERCURY_LSP_CPP=0: mercury-clangd absent',
    !(MERCURY_CLANGD_SERVER_NAME in srcCppOff.builtin),
    'builtinClangdServer in src/integrations/lsp/clangdLane.ts must return {} when MERCURY_LSP_CPP=0',
  )
  check(
    'MERCURY_LSP_CPP=0: builtinClangdServer() is {}',
    Object.keys(builtinClangdServer()).length === 0,
    'builtinClangdServer in src/integrations/lsp/clangdLane.ts must return {} when mercuryLspCppEnabled() is false',
  )
  delete process.env.MERCURY_LSP_CPP

  process.env.MERCURY_LSP = '0'
  _resetClangdProbeCacheForTesting()
  check(
    'MERCURY_LSP=0: the master kill empties every builtin source',
    Object.keys(getMercuryLspServerSources().builtin).length === 0 &&
      Object.keys(getMercuryLspServerSources().env).length === 0,
    'getMercuryLspServerSources in src/integrations/lsp/builtinServers.ts must return empty env and builtin when mercuryLspEnabled (src/integrations/lsp/mercuryLsp.ts) is false',
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
    'probeBuiltinClangd in src/integrations/lsp/clangdLane.ts must resolve a plain clangd found on PATH',
  )
  process.env.PATH = versionedDir
  check(
    'versioned clangd-19 resolves when plain is absent',
    probeBuiltinClangd({ skipSystemFallbacks: true }).clangdPath === versioned,
    'probeBuiltinClangd in src/integrations/lsp/clangdLane.ts must fall back to the VERSIONED_CLANGD_NAMES when plain clangd is absent',
  )
  process.env.PATH = bothDir
  check(
    'plain beats versioned in the same dir',
    probeBuiltinClangd({ skipSystemFallbacks: true }).clangdPath === bothPlain,
    'probeBuiltinClangd in src/integrations/lsp/clangdLane.ts must try plain clangd before the versioned names in findOnPath order',
  )
  process.env.PATH = emptyDir
  const absent = probeBuiltinClangd({ skipSystemFallbacks: true })
  check('empty PATH ⇒ honest absence', !absent.available, 'probeBuiltinClangd in src/integrations/lsp/clangdLane.ts reported available with an empty PATH and skipSystemFallbacks')
  check(
    'absence reason teaches the installs',
    (absent.reason ?? '').includes('brew install llvm') &&
      (absent.reason ?? '').includes('apt install clangd'),
    `the reason text in probeBuiltinClangd in src/integrations/lsp/clangdLane.ts must name both brew install llvm and apt install clangd; got ${JSON.stringify(absent.reason)}`,
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
  check('config present with fake PATH clangd', config !== undefined, 'builtinClangdServer in src/integrations/lsp/clangdLane.ts returned no mercury-clangd entry although a clangd is on PATH')
  if (config) {
    check('command is the resolved binary', config.command === bin, 'builtinClangdServer in src/integrations/lsp/clangdLane.ts must set command to probe.clangdPath')
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
      `CPP_EXTENSION_TO_LANGUAGE in src/integrations/lsp/clangdLane.ts must map .c .cpp .cc .h .hpp .m .mm .cu; got ${JSON.stringify(ext)}`,
    )
    check(
      'args arm clang-tidy + quiet stderr + no header-insertion',
      (config.args ?? []).includes('--clang-tidy') &&
        (config.args ?? []).includes('--log=error') &&
        (config.args ?? []).includes('--header-insertion=never'),
      `the args in builtinClangdServer in src/integrations/lsp/clangdLane.ts must carry --clang-tidy, --log=error and --header-insertion=never; got ${JSON.stringify(config.args)}`,
    )
    check('stdio transport', config.transport === 'stdio', 'builtinClangdServer in src/integrations/lsp/clangdLane.ts must set transport to stdio')
    check('source stamped mercury-builtin', config.source === 'mercury-builtin', 'builtinClangdServer in src/integrations/lsp/clangdLane.ts must set source to mercury-builtin')
    check('workspaceFolder set', typeof config.workspaceFolder === 'string' && config.workspaceFolder.length > 0, 'builtinClangdServer in src/integrations/lsp/clangdLane.ts must set workspaceFolder to getCwd()')
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
    `probeCompileDb in src/integrations/lsp/clangdLane.ts must walk up parent directories to find compile_commands.json; got ${JSON.stringify(fromDeep)}`,
  )

  const projBuild = path.join(scratch, 'proj-build')
  mkdirSync(path.join(projBuild, 'build'), { recursive: true })
  writeFileSync(path.join(projBuild, 'build', 'compile_commands.json'), '[]')
  check(
    'build/compile_commands.json found',
    probeCompileDb(projBuild).compileDb ===
      path.join(projBuild, 'build', 'compile_commands.json'),
    'probeCompileDb in src/integrations/lsp/clangdLane.ts must also look for build/compile_commands.json in each directory it walks',
  )

  const projCmake = path.join(scratch, 'proj-cmake')
  mkdirSync(projCmake, { recursive: true })
  writeFileSync(path.join(projCmake, 'CMakeLists.txt'), '')
  const cmakeProbe = probeCompileDb(projCmake)
  check('CMake-without-DB: no DB, CMakeLists seen', !cmakeProbe.compileDb && !!cmakeProbe.cmakeLists, `probeCompileDb in src/integrations/lsp/clangdLane.ts must return cmakeLists and no compileDb for a CMakeLists.txt-only tree; got ${JSON.stringify(cmakeProbe)}`)
  check(
    'CMake remedy teaches CMAKE_EXPORT_COMPILE_COMMANDS',
    compileDbRemedy(cmakeProbe).includes('CMAKE_EXPORT_COMPILE_COMMANDS'),
    'compileDbRemedy in src/integrations/lsp/clangdLane.ts must name CMAKE_EXPORT_COMPILE_COMMANDS when a CMakeLists.txt was seen',
  )
  const bare = probeCompileDb(path.join(scratch, 'proj-db', 'src'))
  void bare
  const bareProbe = probeCompileDb(scratch)
  check(
    'bare tree remedy mentions bear + compile_flags.txt',
    compileDbRemedy(bareProbe).includes('bear') &&
      compileDbRemedy(bareProbe).includes('compile_flags.txt'),
    'compileDbRemedy in src/integrations/lsp/clangdLane.ts must name bear and compile_flags.txt when no CMakeLists.txt was seen (the scratch folder may sit under a directory with a compile database or CMakeLists.txt)',
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
  const { getAllLspServers } = await import('../../src/integrations/lsp/config.js')
  const merged = Object.keys((await getAllLspServers()).servers)
  const envIdx = merged.indexOf('env:ccls')
  const builtinIdx = merged.indexOf(MERCURY_CLANGD_SERVER_NAME)
  check('env override present', envIdx !== -1, 'getAllLspServers in src/integrations/lsp/config.ts did not list env:ccls from MERCURY_LSP_SERVERS')
  check('builtin clangd still present', builtinIdx !== -1, 'getAllLspServers in src/integrations/lsp/config.ts dropped mercury-clangd; the env override must not remove the builtin')
  check(
    'env override inserted AHEAD of the builtin (claims .cpp first)',
    envIdx !== -1 && builtinIdx !== -1 && envIdx < builtinIdx,
    'the merge loop in getAllLspServers in src/integrations/lsp/config.ts must visit mercurySources.env before mercurySources.builtin',
  )
  delete process.env.MERCURY_LSP_SERVERS
}

section('§6 · registry honesty')
{
  const cppRow = getFlagSpec('MERCURY_LSP_CPP')
  check(
    "flagRegistry: MERCURY_LSP_CPP row (default-on, this proof as evidence)",
    cppRow !== undefined &&
      cppRow.evidence === 'scripts/lsp/prove-clangd-lane.ts',
    'the MERCURY_LSP_CPP row in FLAG_REGISTRY must exist with evidence set to scripts/lsp/prove-clangd-lane.ts',
  )
}

restoreEnv()
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.error(`❌ ${failures} CLANGD-LANE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL CLANGD-LANE PROOFS PASS')
