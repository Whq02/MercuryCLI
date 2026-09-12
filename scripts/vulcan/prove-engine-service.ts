#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'engine-service-home-'))
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_GODOT_WORKERS = '2'
delete process.env.MERCURY_GODOT_TOOLS_LITE

const ROOT = join(import.meta.dir, '..', '..')
const FIXTURE = join(import.meta.dir, 'fixtures', 'engine-service')
process.chdir(ROOT)
const manifestMod = await import(join(ROOT, 'src/services/vulcan/engine/manifest.ts'))
const argvMod = await import(join(ROOT, 'src/services/vulcan/engine/argv.ts'))
const logsMod = await import(join(ROOT, 'src/services/vulcan/engine/logs.ts'))
const userDirMod = await import(join(ROOT, 'src/services/vulcan/engine/userDir.ts'))
const treeMod = await import(join(ROOT, 'src/services/vulcan/engine/frozenTree.ts'))
const spawnMod = await import(join(ROOT, 'src/services/vulcan/engine/spawn.ts'))
const serviceMod = await import(join(ROOT, 'src/services/vulcan/engine/service.ts'))
const opsMod = await import(join(ROOT, 'src/services/vulcan/engine/ops.ts'))
const pathsMod = await import(join(ROOT, 'src/services/vulcan/engine/paths.ts'))
const censusMod = await import(join(ROOT, 'src/services/vulcan/godotProcessCensus.ts'))
const doctorMod = await import(join(ROOT, 'src/services/vulcan/portabilityDoctor.ts'))
const groupMod = await import(join(ROOT, 'src/utils/processGroup.ts'))
const coresMod = await import(join(ROOT, 'src/utils/availableCores.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail.slice(0, 300) : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

console.log('============================================================')
console.log(' engine job service — argv · clean rule · manifest · frozen trees · queue · cache · kill')
console.log('============================================================')

section('1. the argument vectors are the runner\'s, byte for byte')
{
  const root = 'C:\\Users\\WHQ\\Documents\\voxel-atheltide'
  const m = manifestMod.parseEngineManifest(
    JSON.stringify({
      version: 1,
      suites: [
        ['shield_checks', 'SHIELD PASS'],
        { name: 'faran_mercenaries_checks', marker: 'FARANS PASS', script: true },
        { name: 'castle_checks', marker: '/^CASTLE PASS: \\d+ checks, 0 failures$/', quitAfter: 120000, timeoutMs: 720000, nativeOnly: true },
        { name: 'fold_tour', scene: '../.mercury/scratch/fold_tour', nativeOnly: true, quitAfter: 120000, timeoutMs: 720000, marker: 'TOUR DONE' },
        { name: 'warship_checks', marker: 'WARSHIP PASS', userArgs: ['--warship-checks'] },
      ],
    }),
    root,
    'manifest',
  )
  const suite = (n: string) => m.suites.find((s: { name: string }) => s.name === n)
  const line = (a: string[]) => a.join(' ')
  check('manifest parses without problems', m.problems.length === 0, m.problems.join('; '))
  check('import', line(argvMod.engineImportArgv(root)) === `--headless --path ${root} --import`)
  check('headless scene suite', line(argvMod.engineSuiteArgv(root, suite('shield_checks'), m.defaults, { native: false, capture: false })) === `--headless --path ${root} --quit-after 15000 tests/shield_checks.tscn`)
  check('headless script suite', line(argvMod.engineSuiteArgv(root, suite('faran_mercenaries_checks'), m.defaults, { native: false, capture: false })) === `--headless --path ${root} --quit-after 15000 --script res://tests/faran_mercenaries_checks.gd`)
  check('native capture suite', line(argvMod.engineSuiteArgv(root, suite('castle_checks'), m.defaults, { native: true, capture: true })) === `--path ${root} --resolution 1280x720 --audio-driver Dummy --quit-after 120000 tests/castle_checks.tscn -- --capture`)
  check('native tour with a scene under tests/../', line(argvMod.engineSuiteArgv(root, suite('fold_tour'), m.defaults, { native: true, capture: false })) === `--path ${root} --resolution 1280x720 --audio-driver Dummy --quit-after 120000 tests/../.mercury/scratch/fold_tour.tscn`)
  check('user args ride after -- and capture is appended once', line(argvMod.engineSuiteArgv(root, suite('warship_checks'), m.defaults, { native: true, capture: true })) === `--path ${root} --resolution 1280x720 --audio-driver Dummy --quit-after 15000 tests/warship_checks.tscn -- --warship-checks --capture`)
  check('check-only', line(argvMod.engineCheckOnlyArgv('.', 'res://src/x.gd')) === '--headless --path . --check-only --script res://src/x.gd')
  check('the runner\'s defaults: quitAfter 15000 · suite 240000 ms · import 1200000 ms · tests/', m.defaults.quitAfter === 15000 && m.defaults.timeoutMs === 240000 && m.defaults.importTimeoutMs === 1200000 && m.defaults.suiteDir === 'tests')
  check('per-suite overrides land', suite('castle_checks').quitAfter === 120000 && suite('castle_checks').timeoutMs === 720000 && suite('castle_checks').nativeOnly === true)
}

section('2. the clean rule and the marker rule')
{
  const unclean = [
    'Godot Engine v4.7.2.stable.mono.official.ed1daf0bf - https://godotengine.org',
    '',
    'SCRIPT ERROR: Parse Error: Function "_resolve_field_material()" not found in base self.',
    '   at: GDScript::reload (res://src/zone/coastal_terrain.gd:209)',
    'SCRIPT ERROR: Compile Error: Failed to compile depended scripts.',
    '   at: GDScript::reload (res://src/core/main.gd:0)',
    'ERROR: Failed to load script "res://src/core/game_state.gd" with error "Compilation failed".',
    '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
    'DRAGON TARGETING checks=464 failures=0',
    'DRAGON TARGETING PASS',
  ].join('\n')
  const warningOnly = 'WARNING: mercury_vulcan: cannot listen on 127.0.0.1:6010 (Already in use)\n     at: _ready (res://addons/mercury_vulcan/core/server.gd:100)\nchecks=95 failures=0\nSHIELD PASS\n'
  check('the runner\'s regular expression is the default unclean class', manifestMod.RUNNER_UNCLEAN_SOURCE === 'SCRIPT ERROR|SHADER ERROR|Parse Error|^ERROR:|^FAIL:|leaked|resources still in use' && manifestMod.RUNNER_UNCLEAN_FLAGS === 'im')
  check('a SCRIPT ERROR log is unclean even with its marker present', !manifestMod.isCleanEngineLog(unclean))
  check('a WARNING: line never counts (the bridge\'s port warning)', manifestMod.isCleanEngineLog(warningOnly))
  check('FAIL: at a line start is unclean', !manifestMod.isCleanEngineLog('FAIL: expected 3 got 4\n'))
  const shield = manifestMod.parseEngineMarker('SHIELD PASS')
  const castle = manifestMod.parseEngineMarker('/^CASTLE PASS: \\d+ checks, 0 failures$/')
  check('a string marker must equal one whole trimmed line', manifestMod.markerLineOf(shield, warningOnly) === 'SHIELD PASS' && manifestMod.markerLineOf(shield, 'SHIELD PASSED\n') === null && manifestMod.markerLineOf(shield, '   SHIELD PASS   \n') === 'SHIELD PASS')
  check('a /pattern/ marker is tested against each trimmed line', castle.kind === 'pattern' && manifestMod.markerLineOf(castle, 'x\nCASTLE PASS: 12 checks, 0 failures\n') === 'CASTLE PASS: 12 checks, 0 failures' && manifestMod.markerLineOf(castle, 'CASTLE PASS: 12 checks, 1 failures\n') === null)
  check('the marker parser refuses an empty marker and a broken pattern', manifestMod.parseEngineMarker('') === null && manifestMod.parseEngineMarker('/[/') === null && manifestMod.parseEngineMarker({ pattern: '^X$' })?.kind === 'pattern')
  const errors = logsMod.engineLogErrors(unclean)
  check('errors are read with the file and line each names', errors.length === 3 && errors[0].kind === 'script-error' && errors[0].file === 'res://src/zone/coastal_terrain.gd' && errors[0].line === 209 && errors[2].kind === 'error' && errors[2].file === 'modules/gdscript/gdscript_resource_format.cpp' && errors[2].line === 46, JSON.stringify(errors))
  check('FAIL lines are collected whole, case-insensitively like the clean rule', JSON.stringify(logsMod.engineFailLines('FAIL: expected 3 got 4\nchecks=2 failures=1\nfail: lower too\n  FAIL: not at a line start\n')) === JSON.stringify(['FAIL: expected 3 got 4', 'fail: lower too']))
  const shaderErrors = logsMod.engineLogErrors('SHADER ERROR: Invalid arguments for the built-in function: "vec4(vec2,float)".\n          at: (null) (:4)\n')
  check('a SHADER ERROR without a file keeps its line', shaderErrors.length === 1 && shaderErrors[0].kind === 'shader-error' && shaderErrors[0].file === null && shaderErrors[0].line === 4)
}

section('3. the manifest: .mercury/engine-suites.json, the runner\'s defaults, a teaching error without one')
{
  const scratch = mkdtempSync(join(tmpdir(), 'engine-manifest-'))
  try {
    const absent = manifestMod.readEngineManifest(scratch)
    check('no manifest ⇒ not found, no suites, defaults kept, the teaching names the file', absent.found === false && absent.suites.length === 0 && absent.defaults.timeoutMs === 240000 && typeof absent.teaching === 'string' && absent.teaching.includes('.mercury/engine-suites.json') && absent.teaching.includes('"marker"'))
    mkdirSync(join(scratch, '.mercury'), { recursive: true })
    writeFileSync(join(scratch, '.mercury', 'engine-suites.json'), JSON.stringify({ version: 1, unclean: 'SCRIPT ERROR|^FAIL:', defaults: { suiteDir: 'checks', timeoutMs: 1000 }, executable: 'C:/Godot/Godot_console.exe', suites: [{ name: 'a', marker: 'A PASS', userDir: 'keep', local: true }, { name: 'a', marker: 'DUP' }, { name: 'import', marker: 'X' }, { name: 'b' }, ['c', 'C PASS']] }))
    const m = manifestMod.readEngineManifest(scratch)
    check('a manifest is read from .mercury/engine-suites.json with its executable, defaults and unclean class', m.found && m.executable === 'C:/Godot/Godot_console.exe' && m.defaults.suiteDir === 'checks' && m.defaults.timeoutMs === 1000 && m.uncleanSource === 'SCRIPT ERROR|^FAIL:')
    check('good suites land (object and array forms), userDir keep and local kept', m.suites.map((s: { name: string }) => s.name).join(',') === 'a,c' && m.suites[0].userDir === 'keep' && m.suites[0].local === true && m.suites[0].timeoutMs === 1000)
    check('a duplicate, the import name and a suite without a marker are problems, not suites', m.problems.length === 3 && m.problems.some((p: string) => p.includes('twice')) && m.problems.some((p: string) => p.includes('import')) && m.problems.some((p: string) => p.includes('marker')), m.problems.join(' | '))
    const sel = manifestMod.resolveEngineSuites(m, ['import', 'c', 'zzz'])
    check('selection resolves import and names the unknown suite', sel.entries.length === 2 && sel.entries[0].kind === 'import' && sel.entries[1].suite.name === 'c' && sel.unknown.join() === 'zzz')
    check('an empty selection is every registered suite in order', manifestMod.resolveEngineSuites(m, []).entries.map((e: { suite: { name: string } }) => e.suite.name).join(',') === 'a,c')
    check('suite files follow the runner: <dir>/<name>.tscn · res://<dir>/<name>.gd', manifestMod.suiteRelativeFile(m.suites[0], m.defaults) === 'checks/a.tscn' && manifestMod.suiteScriptRes({ ...m.suites[0], script: true }, m.defaults) === 'res://checks/a.gd')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('4. tree specs, the user directory per platform, the tree kill and the console sibling')
{
  const s1 = treeMod.parseEngineTreeSpec(undefined)
  const s2 = treeMod.parseEngineTreeSpec('working')
  const s3 = treeMod.parseEngineTreeSpec('HEAD+src/a.gd, src/b.gd')
  const s4 = treeMod.parseEngineTreeSpec({ ref: 'main', files: ['x.gd'] })
  check('default HEAD · working · HEAD+files · {ref, files}', s1.ref === 'HEAD' && s1.files.length === 0 && s2.working === true && s3.ref === 'HEAD' && s3.files.join() === 'src/a.gd,src/b.gd' && s4.ref === 'main' && s4.files.join() === 'x.gd')
  check('a flag-shaped ref and a path outside the project are refused', 'error' in treeMod.parseEngineTreeSpec('--bad') && treeMod.normalizeTreeFile('../secret.gd') === null && treeMod.normalizeTreeFile('/abs/x.gd') === null && treeMod.normalizeTreeFile('res://src/x.gd') === 'src/x.gd')
  check('the engine\'s own state dirs never ride an overlay', treeMod.isEngineInternalPath('.godot/x') && treeMod.isEngineInternalPath('.mercury/engine/x') && !treeMod.isEngineInternalPath('src/x.gd'))
  check('asset class: project.godot, sidecars and binaries hash; scripts, scenes and text do not', treeMod.isEngineAssetPath('project.godot') && treeMod.isEngineAssetPath('art/tree.png') && treeMod.isEngineAssetPath('art/tree.png.import') && !treeMod.isEngineAssetPath('src/a.gd') && !treeMod.isEngineAssetPath('scenes/a.tscn') && !treeMod.isEngineAssetPath('README.md'))
  check('a script head signature reads only class_name/extends/@tool/@icon/@abstract', treeMod.scriptHeadSignature('@tool\nclass_name Probe\nextends RefCounted\n\nfunc f() -> int:\n\treturn 1\n') === '@tool\nclass_name Probe\nextends RefCounted')
  const win = userDirMod.engineUserEnv('C:\\Temp\\mercury-lane-water-appdata', 'win32')
  const mac = userDirMod.engineUserEnv('/tmp/u', 'darwin')
  const lin = userDirMod.engineUserEnv('/tmp/u', 'linux')
  check('win32: APPDATA alone, as the runner did', JSON.stringify(win) === JSON.stringify({ APPDATA: 'C:\\Temp\\mercury-lane-water-appdata' }))
  check('darwin: HOME (the macOS build ignores XDG_DATA_HOME)', JSON.stringify(mac) === JSON.stringify({ HOME: '/tmp/u' }))
  check('linux: the three XDG homes', JSON.stringify(lin) === JSON.stringify({ XDG_DATA_HOME: '/tmp/u', XDG_CONFIG_HOME: '/tmp/u', XDG_CACHE_HOME: '/tmp/u' }))
  const winData = userDirMod.engineUserDataPath('C:\\Temp\\mercury-lane-water-appdata', 'Voxel Atheltide', 'win32').split(/[\\/]/)
  check('win32 user data: <APPDATA>\\Godot\\app_userdata\\<name>, as the facts list it', winData.slice(-3).join('/') === 'Godot/app_userdata/Voxel Atheltide' && winData[0] === 'C:')
  check('darwin and linux user data paths', userDirMod.engineUserDataPath('/u', 'G', 'darwin') === '/u/Library/Application Support/Godot/app_userdata/G' && userDirMod.engineUserDataPath('/u', 'G', 'linux') === '/u/godot/app_userdata/G')
  const tk = groupMod.win32TaskkillCommand(7400)
  check('the Windows tree kill is taskkill /PID <wrapper> /T /F through an argv array', tk.file === 'taskkill' && tk.args.join(' ') === '/PID 7400 /T /F')
  const exe = 'C:/Users/WHQ/AppData/Local/Programs/Godot/Godot_v4.7.2-stable_mono_win64.exe'
  const consoleExe = 'C:/Users/WHQ/AppData/Local/Programs/Godot/Godot_v4.7.2-stable_mono_win64_console.exe'
  check('on win32 the console wrapper beside the engine carries the output', argvMod.engineConsoleSibling(exe, 'win32', (p: string) => p === consoleExe) === consoleExe && argvMod.engineConsoleSibling(exe, 'win32', () => false) === exe && argvMod.engineConsoleSibling(consoleExe, 'win32', () => true) === consoleExe && argvMod.engineConsoleSibling('/opt/homebrew/bin/godot', 'darwin', () => true) === '/opt/homebrew/bin/godot')
  const w = serviceMod.engineWorkerCount()
  check('MERCURY_GODOT_WORKERS=2 is the worker count, named as the flag', w.count === 2 && w.source === 'flag')
  delete process.env.MERCURY_GODOT_WORKERS
  const w2 = serviceMod.engineWorkerCount()
  const cores = coresMod.availableCores()
  check('unset: min(3, max(1, floor(cores / 2))) from the cores', w2.count === Math.min(3, Math.max(1, Math.floor(cores / 2))) && w2.source === 'cores', `cores ${cores} → ${w2.count}`)
  process.env.MERCURY_GODOT_WORKERS = '2'
  check('priorities: verifier > fold-gate > lane-gate > profile', serviceMod.ENGINE_PRIORITIES.join(' > ') === 'verifier > fold-gate > lane-gate > profile' && serviceMod.ENGINE_DEFAULT_PRIORITY === 'lane-gate')
}

section('5. the live legs — the real engine on the fixture project')
const godotEnv = process.env.GODOT_BIN
const receipt = godotEnv ? { resolved: godotEnv } : await doctorMod.resolveGodotExecutable({ census: [] })
if (!receipt.resolved) {
  console.log('  SKIP — no godot binary on PATH (set GODOT_BIN=…); the live legs need Godot 4')
} else {
  const godot: string = receipt.resolved
  const scratch = mkdtempSync(join(tmpdir(), 'engine-service-'))
  const P = join(scratch, 'game')
  cpSync(FIXTURE, P, { recursive: true })
  mkdirSync(join(P, '.mercury'), { recursive: true })
  cpSync(join(FIXTURE, 'engine-suites.json'), join(P, '.mercury', 'engine-suites.json'))
  const git = (...a: string[]): string => execFileSync('git', ['-C', P, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  const commit = git('rev-parse', 'HEAD').trim()
  const service = new serviceMod.EngineJobService(P, { workers: 2, executable: godot })
  const spec = (s: unknown) => treeMod.parseEngineTreeSpec(s)
  const request = (suites: string[], priority: string, label: string, tree: unknown = 'HEAD', extra: Record<string, unknown> = {}) => ({ suites, tree: spec(tree), native: false, capture: false, priority, budgetMs: null, displayShared: false, keepTree: false, label, ...extra })
  const engineProcs = async (): Promise<number[]> => spawnMod.engineProcessesFor(P, await censusMod.runningGodotProcesses()).map((p: { pid: number }) => p.pid)
  try {
    section('5a. the import cache: an import on the first run, none when the hashes hold, one again when they move')
    const r1 = await service.submit(request(['scene_checks', 'script_checks'], 'lane-gate', 'first'))
    check('the first job is queued (not refused)', !('refused' in r1), 'refused' in r1 ? r1.refused : '')
    const j1 = await service.wait(r1.id, 180_000)
    const rec1 = j1.record
    check('first run: the import ran on a cache miss, was stored, and both suites passed', rec1.importCache.hit === false && rec1.importCache.ran === true && rec1.importCache.stored === true && rec1.allPass === true && rec1.complete === true, JSON.stringify({ ic: rec1.importCache, rows: rec1.results.map((r: { name: string; ok: boolean }) => [r.name, r.ok]) }))
    check('the import row leads the record like the runner\'s', rec1.results[0].name === 'import' && rec1.results[0].ok === true && rec1.results[0].marker === true)
    const r2 = await service.submit(request(['scene_checks', 'script_checks'], 'lane-gate', 'second'))
    const j2 = await service.wait(r2.id, 180_000)
    check('second run, same inputs: the cache hit, no import row, still passing', j2.record.importCache.hit === true && j2.record.importCache.ran === false && !j2.record.results.some((r: { name: string }) => r.name === 'import') && j2.record.allPass === true)
    writeFileSync(join(P, 'src/probe.gd'), 'class_name Probe\nextends RefCounted\n\nfunc count() -> int:\n\tvar n := 3\n\treturn n\n')
    const r3 = await service.submit(request(['script_checks'], 'lane-gate', 'body-edit', 'working'))
    const j3 = await service.wait(r3.id, 180_000)
    check('a body-only script edit keeps the class cache: no import', j3.record.importCache.hit === true && j3.record.allPass === true && j3.record.tree.files.join() === 'src/probe.gd')
    writeFileSync(join(P, 'src/probe.gd'), 'class_name ProbeRenamed\nextends RefCounted\n\nfunc count() -> int:\n\treturn 3\n')
    const r4 = await service.submit(request(['scene_checks'], 'lane-gate', 'class-rename', 'working'))
    const j4 = await service.wait(r4.id, 180_000)
    check('a class_name change moves the script hash: the import runs again', j4.record.importCache.hit === false && j4.record.importCache.ran === true, JSON.stringify(j4.record.importCache))
    git('checkout', '--', 'src/probe.gd')

    section('5b. the record: the runner\'s fields, the FAIL lines, the errors with their files and last change')
    const r5 = await service.submit(request(['fail_checks', 'preload_checks', 'draft_checks'], 'lane-gate', 'record'))
    const j5 = await service.wait(r5.id, 180_000)
    const rec = j5.record
    const runnerRowKeys = ['name', 'ok', 'exitCode', 'signal', 'timedOut', 'spawnError', 'clean', 'marker', 'seconds', 'log']
    const failRow = rec.results.find((r: { name: string }) => r.name === 'fail_checks')
    const preloadRow = rec.results.find((r: { name: string }) => r.name === 'preload_checks')
    const draftRow = rec.results.find((r: { name: string }) => r.name === 'draft_checks')
    check('top level carries root, executable, results, complete, allPass', typeof rec.root === 'string' && rec.executable === godot && Array.isArray(rec.results) && rec.complete === true && rec.allPass === false)
    check('every ran row carries the runner\'s ten fields', [failRow, preloadRow].every(r => runnerRowKeys.every(k => k in r)), JSON.stringify(Object.keys(failRow)))
    check('fail_checks: exit 1, marker missing, the FAIL line kept', failRow.ok === false && failRow.exitCode === 1 && failRow.marker === false && failRow.failLines.join() === 'FAIL: expected 3 got 4' && failRow.clean === false)
    check('preload_checks: marker printed and exit 0 yet unclean — the triple catches it', preloadRow.ok === false && preloadRow.exitCode === 0 && preloadRow.marker === true && preloadRow.markerLine === 'PRELOAD PASS' && preloadRow.clean === false)
    const compileError = preloadRow.errors.find((e: { message: string }) => e.message === 'Compile Error: Identifier not found: Events')
    check('the compile error names its file, line and who last changed it', compileError && compileError.file === 'res://src/autoload_user.gd' && compileError.line === 4 && typeof compileError.lastChange === 'string' && compileError.lastChange.startsWith(commit.slice(0, 12)) && compileError.lastChange.includes('fixture'), JSON.stringify(compileError))
    check('a local draft whose file is absent is skipped and never counts as passed', draftRow && draftRow.skipped === true && /absent/.test(draftRow.reason))
    check('seconds are tenths and the log path is a file in the run directory', Number.isInteger(failRow.seconds * 10) && existsSync(failRow.log) && failRow.log.startsWith(j5.runDir) && readFileSync(failRow.log, 'utf8').includes('FAIL: expected 3 got 4'))
    const onDisk = JSON.parse(readFileSync(join(j5.runDir, 'result.json'), 'utf8'))
    check('result.json on disk is the record', onDisk.jobId === rec.jobId && onDisk.allPass === false && onDisk.results.length === 3)
    check('the frozen tree is removed after the run and the record says so', !existsSync(j5.treePath) && rec.tree.kept === false && rec.tree.commit === commit)
    check('the job\'s user directory is empty at birth and Godot wrote its user:// under it', existsSync(userDirMod.engineUserDataPath(rec.userDir, 'engine-service-fixture')))

    section('5c. the queue: two headless jobs at once, the third waits by priority')
    const s1 = await service.submit(request(['slow_checks'], 'lane-gate', 'slow1'))
    const s2 = await service.submit(request(['slow_checks'], 'lane-gate', 'slow2'))
    const p3 = await service.submit(request(['script_checks'], 'profile', 'profile3'))
    const v4 = await service.submit(request(['script_checks'], 'verifier', 'verifier4'))
    await sleep(1000)
    const snap = service.jobs()
    check('two run at once on two workers, two wait', snap.running.length === 2 && snap.queued.length === 2 && snap.workers.busy === 2, JSON.stringify({ running: snap.running.map((j: { label: string }) => j.label), queued: snap.queued.map((j: { label: string }) => j.label) }))
    check('the verifier waits ahead of the profile though queued later', snap.queued[0].label === 'verifier4' && snap.queued[1].label === 'profile3')
    const during = await engineProcs()
    check('the census sees both engines under the project\'s .mercury/engine/ trees', during.length === 2, JSON.stringify(during))
    for (const j of [s1, s2, p3, v4]) await service.wait(j.id, 180_000)
    const started = (id: string): string => service.job(id).startedAt
    check('the verifier started before the profile', started(v4.id) < started(p3.id), `${started(v4.id)} vs ${started(p3.id)}`)
    const slowRow = service.job(s1.id).record.results[0]
    check('a suite past its manifest timeout is killed and recorded timedOut', slowRow.timedOut === true && slowRow.ok === false && slowRow.seconds >= 3.5 && slowRow.seconds < 20, JSON.stringify({ seconds: slowRow.seconds, signal: slowRow.signal }))
    check('no engine process survives the timeouts', (await engineProcs()).length === 0)

    section('5d. a frozen tree never sees a half-edit written after the job was queued')
    const f1 = await service.submit(request(['script_checks'], 'lane-gate', 'frozen-before-edit', 'working'))
    writeFileSync(join(P, 'src/probe.gd'), 'class_name Probe\nextends RefCounted\n\nfunc count() -> int\n\treturn 3\n')
    const f2 = await service.submit(request(['script_checks'], 'lane-gate', 'frozen-after-edit', 'working'))
    const f3 = await service.submit(request(['script_checks'], 'lane-gate', 'head-after-edit', 'HEAD'))
    const f4 = await service.submit(request(['script_checks'], 'lane-gate', 'head-plus-file', 'HEAD+src/probe.gd'))
    for (const j of [f1, f2, f3, f4]) await service.wait(j.id, 180_000)
    check('the job queued before the edit passes on its frozen copy', service.job(f1.id).record.allPass === true)
    check('a working-tree job queued after the edit sees it and fails', service.job(f2.id).record.allPass === false && service.job(f2.id).record.tree.files.join() === 'src/probe.gd')
    check('a HEAD job never sees the working tree', service.job(f3.id).record.allPass === true && service.job(f3.id).record.tree.files.length === 0)
    const plusErrors = service.job(f4.id).record.results[0].errors
    check('HEAD plus the edited file is the fold\'s shape: the edit rides, attributed uncommitted', service.job(f4.id).record.allPass === false && service.job(f4.id).record.tree.files.join() === 'src/probe.gd' && plusErrors.length > 0, JSON.stringify(plusErrors.slice(0, 2)))
    check('the live tree still carries the edit untouched', readFileSync(join(P, 'src/probe.gd'), 'utf8').includes('func count() -> int\n'))
    git('checkout', '--', 'src/probe.gd')

    section('5e. cancel: the running engine tree ends, the census sees nothing')
    const long = await service.submit(request(['long_checks'], 'lane-gate', 'long'))
    let seen = 0
    for (let i = 0; i < 100 && seen === 0; i++) {
      await sleep(200)
      seen = (await engineProcs()).length
    }
    check('the long job\'s engine is alive before the cancel', seen === 1)
    const cancelled = await service.cancel(long.id)
    check('cancel ends the tree with a counted receipt', !('error' in cancelled) && cancelled.state === 'cancelled' && cancelled.receipt !== null && cancelled.receipt.ended >= 1 && cancelled.receipt.survivors.length === 0, JSON.stringify(cancelled))
    const longRec = service.job(long.id).record
    check('the record says cancelled on the run and on the row', longRec.cancelled === true && longRec.results[0].cancelled === true && longRec.allPass === false)
    check('no engine process survives the cancel', (await engineProcs()).length === 0)
    const queuedCancel = await service.submit(request(['long_checks'], 'lane-gate', 'queued-cancel'))
    const q2 = await service.submit(request(['long_checks'], 'lane-gate', 'queued-cancel-2'))
    const q3 = await service.submit(request(['long_checks'], 'lane-gate', 'queued-cancel-3'))
    const c3 = await service.cancel(q3.id)
    check('a queued job leaves the queue on cancel without an engine', !('error' in c3) && c3.state === 'cancelled' && c3.receipt === null && !existsSync(q3.treePath))
    await service.cancel(queuedCancel.id)
    await service.cancel(q2.id)

    section('5f. refusals teach: native-only, capture without native, unknown suites, the display')
    const nat = await service.submit(request(['native_checks'], 'lane-gate', 'nat'))
    const cap = await service.submit(request(['scene_checks'], 'lane-gate', 'cap', 'HEAD', { capture: true }))
    const unk = await service.submit(request(['nope'], 'lane-gate', 'unk'))
    check('a native-only suite without native:true is refused with the fix', 'refused' in nat && /native-only/.test(nat.refused) && /native:true/.test(nat.refused))
    check('--capture requires --native, in the runner\'s words', 'refused' in cap && /--capture requires --native/.test(cap.refused))
    check('an unknown suite is refused naming the registered ones', 'refused' in unk && /Unknown suite: nope/.test(unk.refused) && /scene_checks/.test(unk.refused))
    const heldService = new serviceMod.EngineJobService(join(scratch, 'held'), {
      workers: 1,
      executable: godot,
      census: async () => [{ pid: 4242, executable: godot, args: '--path /elsewhere --editor', editor: true, headless: false, project: '/elsewhere' }],
    })
    cpSync(P, join(scratch, 'held'), { recursive: true })
    const held = await heldService.submit(request(['native_checks'], 'lane-gate', 'held', 'HEAD', { native: true }))
    const heldJob = await heldService.wait(held.id, 60_000)
    check('a native job never runs while the operator\'s editor holds the display unless asked', heldJob.state === 'failed' && /display is held by/.test(heldJob.error ?? '') && /displayShared:true/.test(heldJob.error ?? ''), heldJob.error ?? '')

    section('5g. the ops answer as data')
    const jobsText = await opsMod.runEngineOp('engine_jobs', {}, P)
    const jobs = JSON.parse(jobsText)
    check('engine_jobs: workers, the manifest\'s suites, recent runs', jobs.workers.count >= 1 && jobs.manifest.suites.includes('scene_checks') && Array.isArray(jobs.recent) && Array.isArray(jobs.runsOnDisk) && jobs.runsOnDisk.includes(rec.jobId))
    const resText = await opsMod.runEngineOp('engine_result', { id: rec.jobId, tail: 200 }, P)
    const res = JSON.parse(resText)
    check('engine_result: the record by id with the failed suites\' log tails', res.jobId === rec.jobId && res.logTails.fail_checks.includes('FAIL: expected 3 got 4') && !('scene_checks' in res.logTails))
    check('engine_result without a run teaches', /no run nope under \.mercury\/engine\/runs/.test(await opsMod.runEngineOp('engine_result', { id: 'nope' }, P)))
    check('engine_cancel without an id teaches', /needs \{id\}/.test(await opsMod.runEngineOp('engine_cancel', {}, P)))
    check('engine_run refuses a bad tree spec before queueing', /engine_run refused: tree "--bad"/.test(await opsMod.runEngineOp('engine_run', { tree: '--bad' }, P)))
    check('engine_run refuses a bad priority naming the order', /verifier > fold-gate > lane-gate > profile/.test(await opsMod.runEngineOp('engine_run', { priority: 'urgent' }, P)))
    check('the permission words name the engine, never the editor', /frozen copy/.test(opsMod.engineOpPermissionMessage('engine_run', { suites: ['a'] })) && /editor is not touched/.test(opsMod.engineOpPermissionMessage('engine_cancel', { id: 'x' })) && opsMod.engineOpPermissionMessage('engine_jobs', {}) === null)
    check('the estate under the project carries a .gdignore so the operator\'s editor never scans the trees', existsSync(join(pathsMod.engineDir(P), '.gdignore')))
  } finally {
    await service.shutdown()
    const leftovers = await engineProcs()
    check('every engine the proof started is gone', leftovers.length === 0, JSON.stringify(leftovers))
    rmSync(scratch, { recursive: true, force: true })
  }
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '✅ engine service proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
