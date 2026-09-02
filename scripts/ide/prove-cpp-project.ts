#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-cpp-project.ts
//  PROOF: the C/C++ project profile service + build operations (ide
// src/services/ide/cppProject.ts + cppBuild.ts).
//
//  Contract proven here:
//   (1) COMPILE-DB VERDICT — the profile reports what clangd ACTUALLY uses:
//       probeCompileDb's walk precedence (root compile_commands.json >
//       build/compile_commands.json > compile_flags.txt > .clangd), and the
//       absent case carries compileDbRemedy's exact teaching line. The
//       verdict is REUSED from clangdLane — a source pin fails any second
//       walk implementation.
//   (2) PROFILE EVIDENCE — CMakePresets parsing (names, hidden skipped,
//       binaryDir macro expansion, malformed JSON typed — never thrown),
//       .clangd/.clang-tidy/.clang-format evidence, build-dir candidates
//       with generator markers.
//   (3) BUILD OPS, typed refusals — deterministic on ANY machine:
//       configureConventional refuses when presets exist; unknown preset
//       names the declared set; build/clean without a configured dir refuse;
//       a scrubbed PATH yields the cmake-missing remedy (never a throw).
//   (4) BUILD OPS, real cmake — IF cmake is on the machine (LOUD skip
//       otherwise): configureConventional on a minimal fixture produces a
//       compile_commands.json that probeCompileDb then finds
//       (compileDbVisibleToClangd), buildTarget compiles, clean runs the
//       build system's own clean target.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-cpp-project.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — proof exceeded 480s')
  process.exit(1)
}, 480_000)
guard.unref?.()

const cppProject = await import('../../src/services/ide/cppProject.js')
const cppBuild = await import('../../src/services/ide/cppBuild.js')
const { probeCompileDb, compileDbRemedy } = await import('../../src/services/lsp/clangdLane.js')

const {
  buildCppProjectProfile,
  cppCompileDbVerdict,
  parseCMakePresets,
  findCppProjectRoot,
  _resetCppProjectForTesting,
} = cppProject
const {
  listCMakePresets,
  configurePreset,
  configureConventional,
  buildTarget,
  clean,
  _resetCppBuildForTesting,
} = cppBuild

function freshProfile(from: string): ReturnType<typeof buildCppProjectProfile> {
  _resetCppProjectForTesting()
  return buildCppProjectProfile(from)
}

console.log('============================================================')
console.log(' C/C++ project profile + build ops (slice 5) — proof')
console.log('============================================================')

section('(1) compile-DB verdict — the walk precedence, root > build/ > flags > .clangd')
{
  const ws = mkdtempSync(join(tmpdir(), 'cpp-profile-'))
  try {
    writeFileSync(join(ws, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(demo C)\n')
    mkdirSync(join(ws, 'build'))
    writeFileSync(join(ws, 'compile_commands.json'), '[]')
    writeFileSync(join(ws, 'build', 'compile_commands.json'), '[]')
    writeFileSync(join(ws, 'compile_flags.txt'), '-std=c11\n')
    writeFileSync(join(ws, '.clangd'), 'CompileFlags:\n  Add: [-Wall]\n')

    let v = cppCompileDbVerdict(ws)
    check('all four present ⇒ root compile_commands.json wins', v.state === 'ok' && v.source === 'root' && v.path === join(ws, 'compile_commands.json'), JSON.stringify(v))

    rmSync(join(ws, 'compile_commands.json'))
    v = cppCompileDbVerdict(ws)
    check('root removed ⇒ build/compile_commands.json', v.state === 'ok' && v.source === 'build-dir' && v.path === join(ws, 'build', 'compile_commands.json'), JSON.stringify(v))

    rmSync(join(ws, 'build', 'compile_commands.json'))
    v = cppCompileDbVerdict(ws)
    check('build DB removed ⇒ compile_flags.txt', v.state === 'ok' && v.source === 'compile-flags', JSON.stringify(v))

    rmSync(join(ws, 'compile_flags.txt'))
    v = cppCompileDbVerdict(ws)
    check('flags removed ⇒ .clangd config', v.state === 'ok' && v.source === 'clangd-config', JSON.stringify(v))

    rmSync(join(ws, '.clangd'))
    v = cppCompileDbVerdict(ws)
    const expectedRemedy = compileDbRemedy(probeCompileDb(ws))
    check('nothing left ⇒ absent + the EXACT lane remedy (CMakeLists present ⇒ cmake line)', v.state === 'absent' && v.remedy === expectedRemedy && v.remedy.includes('cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'), JSON.stringify(v))

    // The remedy honesty flips with the evidence: no CMakeLists ⇒ the ladder.
    rmSync(join(ws, 'CMakeLists.txt'))
    v = cppCompileDbVerdict(ws)
    check('no CMakeLists ⇒ the fallback-flags ladder remedy', v.state === 'absent' && v.remedy.includes('bear -- make'), JSON.stringify(v))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

section('(2) profile evidence — presets, configs, build dirs; ONE walk implementation')
{
  const ws = mkdtempSync(join(tmpdir(), 'cpp-presets-'))
  try {
    writeFileSync(join(ws, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(demo C)\n')
    writeFileSync(
      join(ws, 'CMakePresets.json'),
      JSON.stringify({
        version: 6,
        configurePresets: [
          { name: 'base', hidden: true, binaryDir: '${sourceDir}/out/${presetName}' },
          { name: 'debug', displayName: 'Debug', inherits: 'base', binaryDir: '${sourceDir}/out/${presetName}' },
          { name: 'release', inherits: 'base' },
        ],
        buildPresets: [{ name: 'debug-build', configurePreset: 'debug' }],
      }),
    )
    writeFileSync(join(ws, '.clang-tidy'), 'Checks: "-*,readability-*"\n')
    writeFileSync(join(ws, '.clang-format'), 'BasedOnStyle: LLVM\n')
    mkdirSync(join(ws, 'cmake-build-debug'))
    writeFileSync(join(ws, 'cmake-build-debug', 'build.ninja'), '# ninja\n')
    mkdirSync(join(ws, 'out', 'debug'), { recursive: true })
    writeFileSync(join(ws, 'out', 'debug', 'CMakeCache.txt'), '# cache\n')

    const nested = join(ws, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    check('root detection walks up from a nested dir', findCppProjectRoot(nested).root === ws)

    const profile = freshProfile(ws)
    check('markers carry the root evidence', profile.markers.includes('CMakeLists.txt') && profile.markers.includes('CMakePresets.json'), profile.markers.join(','))
    check('hidden presets are skipped; declared names parse in order', profile.cmake.presets.map(p => p.name).join(',') === 'debug,release', JSON.stringify(profile.cmake.presets))
    check('binaryDir macros expand (${sourceDir}/${presetName})', profile.cmake.presets[0]?.binaryDir === join(ws, 'out', 'debug'), String(profile.cmake.presets[0]?.binaryDir))
    check('build presets parse', profile.cmake.buildPresets.join(',') === 'debug-build')
    check('.clang-tidy evidence', profile.clangTidy.configured && profile.clangTidy.evidence === '.clang-tidy')
    check('.clang-format evidence', profile.clangFormat.configured && profile.clangFormat.evidence === '.clang-format')
    check('.clangd absent ⇒ not configured', profile.clangd.configured === false)
    const dirPaths = profile.buildDirs.map(d => d.path)
    check('conventional build dir found (cmake-build-debug, ninja generator)', profile.buildDirs.some(d => d.path === join(ws, 'cmake-build-debug') && d.generator === 'ninja'), dirPaths.join(','))
    check('preset binaryDir joins the candidates (configured via CMakeCache)', profile.buildDirs.some(d => d.path === join(ws, 'out', 'debug') && d.configured), dirPaths.join(','))
    check('buildSystem evidence: ninja true', profile.buildSystem.ninja === true)

    // Malformed presets: typed, never thrown.
    writeFileSync(join(ws, 'CMakePresets.json'), '{ not json')
    const broken = parseCMakePresets(ws)
    check('malformed CMakePresets.json ⇒ typed presetsError', broken.presetsError !== undefined && broken.presets.length === 0, String(broken.presetsError))
    _resetCppProjectForTesting()
    const listing = listCMakePresets(ws)
    check('listCMakePresets surfaces the parse error as state error', listing.state === 'error' && listing.detail.includes('did not parse'), listing.detail)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }

  // ONE walk implementation: the profile module must import the lane's probe,
  // and must not carry its own compile-DB filename walk.
  const src = readFileSync(join(ROOT, 'src', 'services', 'ide', 'cppProject.ts'), 'utf8')
  check('cppProject REUSES probeCompileDb/compileDbRemedy from clangdLane', src.includes("from '../lsp/clangdLane.js'") && src.includes('probeCompileDb') && src.includes('compileDbRemedy'))
  // The distinctive rungs of the lane's walk (compile_flags.txt / .clangd as
  // DB candidates) must appear ONLY via the import — a second up-walk over
  // them is the forbidden duplicate. (Per-build-dir compile_commands.json
  // presence is candidate EVIDENCE, not a verdict walk — allowed.)
  check('…and implements no second verdict walk (no compile_flags.txt probing of its own)', !src.match(/existsSync\([^)]*compile_flags\.txt/) && !src.includes('COMPILE_DB_WALK'))
}

section('(3) build ops — typed refusals (deterministic, cmake-independent ordering)')
{
  const ws = mkdtempSync(join(tmpdir(), 'cpp-build-refusals-'))
  try {
    writeFileSync(join(ws, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(demo C)\n')
    writeFileSync(
      join(ws, 'CMakePresets.json'),
      JSON.stringify({ version: 6, configurePresets: [{ name: 'debug', binaryDir: '${sourceDir}/out' }] }),
    )
    _resetCppProjectForTesting()
    const conv = await configureConventional(ws)
    check('configureConventional REFUSES when presets exist (names them)', !conv.ok && conv.exitCode === null && conv.argv.length === 0 && conv.detail.includes('debug') && conv.detail.includes('use configurePreset'), conv.detail)
    const unknown = await configurePreset('nope', ws)
    check('unknown preset refusal names the declared set', !unknown.ok && unknown.detail.includes('debug') && unknown.detail.includes('nope'), unknown.detail)
    const build = await buildTarget({ from: ws })
    check('build without a configured dir refuses with the remedy', !build.ok && build.detail.includes('configurePreset/configureConventional'), build.detail)
    const badPreset = await buildTarget({ from: ws, preset: 'ghost' })
    check('unknown build preset refuses (no build presets declared)', !badPreset.ok && badPreset.detail.includes('no build presets declared'), badPreset.detail)
    _resetCppProjectForTesting()
    const cl = await clean(buildCppProjectProfile(ws))
    check('clean without a configured dir refuses (never deletes paths itself)', !cl.ok && cl.detail.includes('never deletes'), cl.detail)

    // cmake-missing remedy: scrub PATH, reset the probe cache, expect the
    // typed refusal — on EVERY machine, cmake installed or not.
    const noPresets = mkdtempSync(join(tmpdir(), 'cpp-nocmake-'))
    writeFileSync(join(noPresets, 'CMakeLists.txt'), 'project(x C)\n')
    const savedPath = process.env.PATH
    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-path-'))
    process.env.PATH = emptyDir
    _resetCppBuildForTesting()
    _resetCppProjectForTesting()
    try {
      const noCmake = await configureConventional(noPresets)
      check('scrubbed PATH ⇒ typed cmake-missing refusal (never a throw)', !noCmake.ok && noCmake.exitCode === null && noCmake.detail.includes('cmake is not on PATH'), noCmake.detail)
    } finally {
      process.env.PATH = savedPath
      _resetCppBuildForTesting()
      _resetCppProjectForTesting()
      rmSync(noPresets, { recursive: true, force: true })
      rmSync(emptyDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

section('(4) build ops — real cmake fixture (machine-dependent)')
{
  const { whichSync } = await import('../../src/utils/which.js')
  const cmake = whichSync('cmake')
  if (!cmake) {
    console.log('  [SKIP — LOUD] cmake is not on PATH on this machine: the real configure/build/clean')
    console.log('  legs cannot run. remedy: brew install cmake · apt install cmake.')
    console.log('  (the typed-refusal legs above still pin every refusal contract)')
  } else {
    const ws = mkdtempSync(join(tmpdir(), 'cpp-build-real-'))
    try {
      writeFileSync(
        join(ws, 'CMakeLists.txt'),
        'cmake_minimum_required(VERSION 3.16)\nproject(demo C)\nadd_executable(demo main.c)\n',
      )
      writeFileSync(join(ws, 'main.c'), '#include <stdio.h>\nint main(void){printf("ok\\n");return 0;}\n')
      _resetCppProjectForTesting()
      _resetCppBuildForTesting()

      const conf = await configureConventional(ws)
      check('configureConventional exits 0 (typed run)', conf.ok && conf.exitCode === 0 && conf.argv.length >= 4, conf.detail)
      check('…argv is the documented remedy verbatim', conf.argv.slice(1).join(' ') === '-B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON', conf.argv.join(' '))
      check('…produces build/compile_commands.json', conf.compileDb === join(ws, 'build', 'compile_commands.json'), String(conf.compileDb))
      check('…which probeCompileDb (the clangd walk) then FINDS', conf.compileDbVisibleToClangd === true && probeCompileDb(ws).compileDb === conf.compileDb, JSON.stringify(probeCompileDb(ws)))
      check('…duration + bounded tail recorded', conf.durationMs > 0 && conf.outputTail.length > 0 && conf.outputTail.length <= 40)

      _resetCppProjectForTesting()
      const built = await buildTarget({ from: ws, target: 'demo' })
      check('buildTarget demo exits 0 via the configured dir', built.ok && built.argv.includes('--build') && built.argv.includes('--target'), built.detail)

      _resetCppProjectForTesting()
      const cl = await clean(buildCppProjectProfile(ws))
      check('clean runs the build system clean target', cl.ok && cl.argv.join(' ').includes('--target clean'), cl.detail)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ALL C/C++ PROJECT + BUILD-OP CHECKS PASS')
  process.exit(0)
}
console.log(` ${failures} CHECK(S) FAILED`)
process.exit(1)
