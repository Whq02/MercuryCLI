#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'engine-check-home-'))
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_GODOT_WORKERS = '2'
delete process.env.MERCURY_GODOT_TOOLS_LITE

const ROOT = join(import.meta.dir, '..', '..')
const FIXTURE = join(import.meta.dir, 'fixtures', 'engine-service')
process.chdir(ROOT)
const gate = await import(join(ROOT, 'src/services/vulcan/engine/compileGate.ts'))
const argvMod = await import(join(ROOT, 'src/services/vulcan/engine/argv.ts'))
const spawnMod = await import(join(ROOT, 'src/services/vulcan/engine/spawn.ts'))
const pathsMod = await import(join(ROOT, 'src/services/vulcan/engine/paths.ts'))
const opsMod = await import(join(ROOT, 'src/services/vulcan/engine/ops.ts'))
const doctorMod = await import(join(ROOT, 'src/services/vulcan/portabilityDoctor.ts'))
const censusMod = await import(join(ROOT, 'src/services/vulcan/godotProcessCensus.ts'))
const promptMod = await import(join(ROOT, 'src/tools/GodotTool/prompt.ts'))
const optable = await import(join(ROOT, 'src/utils/vulcan/optable.generated.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail.slice(0, 300) : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' engine compile gate — autoloads · check-only reading · shaders · preload graph · the live gate')
console.log('============================================================')

section('1. the autoload list comes from project.godot, exactly')
{
  const scratch = mkdtempSync(join(tmpdir(), 'engine-autoload-'))
  try {
    writeFileSync(join(scratch, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Voxel Atheltide"\n\n[autoload]\n\nEvents="*res://src/core/events.gd"\nGameState="*res://src/core/game_state.gd"\nMercuryVulcanRuntime="*res://addons/mercury_vulcan/runtime/runtime.gd"\n\n[input]\n\nEvents_not_here={}\n')
    check('the [autoload] keys, nothing from other sections', JSON.stringify(gate.projectAutoloads(scratch)) === JSON.stringify(['Events', 'GameState', 'MercuryVulcanRuntime']))
    check('no project.godot ⇒ no autoloads', gate.projectAutoloads(join(scratch, 'nowhere')).length === 0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('2. reading a --check-only log: the autoload line is ignored, nothing else is')
{
  const autoloadOnly = 'Godot Engine v4.7.2.stable.mono.official.ed1daf0bf - https://godotengine.org\n\nSCRIPT ERROR: Compile Error: Identifier not found: Events\n          at: GDScript::reload (res://src/autoload_user.gd:4)\nERROR: Failed to load script "res://src/autoload_user.gd" with error "Compilation failed".\n   at: load (modules/gdscript/gdscript.cpp:2907)\n'
  const r1 = gate.readCheckOnlyOutput(autoloadOnly, 'res://src/autoload_user.gd', ['Events'])
  check('Identifier not found: <autoload> is ignored and recorded as such', r1.diagnostics.length === 0 && r1.ignored.length === 1 && r1.ignored[0].autoload === 'Events' && r1.ignored[0].file === 'res://src/autoload_user.gd' && r1.ignored[0].line === 4, JSON.stringify(r1))
  const r2 = gate.readCheckOnlyOutput(autoloadOnly, 'res://src/autoload_user.gd', ['GameState'])
  check('the same line for a name that is not an autoload stays a compile error', r2.diagnostics.length === 1 && r2.diagnostics[0].class === 'compile-error' && r2.ignored.length === 0)
  const parseError = 'SCRIPT ERROR: Parse Error: Unexpected "Indent" in class body.\n          at: GDScript::reload (res://src/broken.gd:4)\nERROR: Failed to load script "res://src/broken.gd" with error "Parse error".\n   at: load (modules/gdscript/gdscript.cpp:2907)\n'
  const r3 = gate.readCheckOnlyOutput(parseError, 'res://src/broken.gd', ['Events'])
  check('a parse error keeps its file, line and class; the redundant ERROR: load line is dropped', r3.diagnostics.length === 1 && r3.diagnostics[0].class === 'parse-error' && r3.diagnostics[0].file === 'res://src/broken.gd' && r3.diagnostics[0].line === 4 && /Unexpected "Indent"/.test(r3.diagnostics[0].message))
  const depended = 'SCRIPT ERROR: Compile Error: Identifier not found: Events\n          at: GDScript::reload (res://src/autoload_user.gd:4)\nSCRIPT ERROR: Compile Error: Failed to compile depended scripts.\n          at: GDScript::reload (res://tests/preload_checks.gd:0)\n'
  const r4 = gate.readCheckOnlyOutput(depended, 'res://tests/preload_checks.gd', ['Events'])
  check('"Failed to compile depended scripts" is ignored only when every missing identifier was an autoload', r4.diagnostics.length === 0 && r4.ignored.length === 2)
  const r5 = gate.readCheckOnlyOutput(parseError + depended, 'res://tests/preload_checks.gd', ['Events'])
  check('with a real error beside it, the depended line stays', r5.diagnostics.length === 2 && r5.ignored.length === 1)
  const typo = 'SCRIPT ERROR: Parse Error: Identifier "Probe" not declared in the current scope.\n          at: GDScript::reload (res://tests/scene_checks.gd:4)\n'
  const r6 = gate.readCheckOnlyOutput(typo, 'res://tests/scene_checks.gd', ['Events'])
  check('an undeclared identifier that is not an autoload is a parse error', r6.diagnostics.length === 1 && r6.diagnostics[0].class === 'parse-error')
}

section('3. shaders: the generated probe and its reading')
{
  const script = gate.shaderCheckScript(['res://shaders/a.gdshader', 'res://shaders/b.gdshader'])
  check('the probe is a SceneTree script that loads each shader, asks for its uniforms (the compile) and marks each on stderr', /extends SceneTree/.test(script) && /printerr\("MERCURY SHADER %s" % p\)/.test(script) && /get_shader_uniform_list\(\)/.test(script) && /printerr\("MERCURY SHADER DONE"\)/.test(script) && script.includes('"res://shaders/a.gdshader", "res://shaders/b.gdshader"') && !/#/.test(script))
  const out = 'MERCURY SHADER res://shaders/a.gdshader\nMERCURY SHADER res://shaders/b.gdshader\n--Main Shader--\n    2 | \nE   4->  COLOR = vec4(UV, 0.0);\nSHADER ERROR: Invalid arguments for the built-in function: "vec4(vec2,float)".\n          at: (null) (:4)\nERROR: Shader compilation failed.\n   at: shader_set_code (servers/rendering/dummy/storage/material_storage.cpp:190)\nMERCURY SHADER res://shaders/c.gdshader\nMERCURY SHADER MISSING res://shaders/c.gdshader\nMERCURY SHADER DONE\n'
  const read = gate.readShaderCheckOutput(out)
  check('errors attribute to the shader named by the last marker, with the line', read.length === 2 && read[0].file === 'res://shaders/b.gdshader' && read[0].line === 4 && /vec4\(vec2,float\)/.test(read[0].message) && read[1].file === 'res://shaders/c.gdshader' && /did not load/.test(read[1].message), JSON.stringify(read))
}

section('4. the preload graph: a --script suite reaching an autoload user')
{
  check('preload targets are read with their lines; a commented-out preload is not one', JSON.stringify(gate.preloadTargets('extends SceneTree\n\nconst Helper := preload("res://src/autoload_user.gd")\n# const Old := preload("res://src/old.gd")\nvar x = load("res://dyn.gd")\n')) === JSON.stringify([{ path: 'res://src/autoload_user.gd', line: 3 }]))
  check('autoload mentions skip strings, comments and member accesses', JSON.stringify(gate.autoloadMentions('func f():\n\tEvents.announce("Events")\n\t# Events here\n\tself.Events = 1\n\tvar GameStates = 2\n', ['Events', 'GameState'])) === JSON.stringify([{ autoload: 'Events', line: 2 }]))
  check('scene files contribute their Script and PackedScene ext_resources', JSON.stringify(gate.sceneScriptTargets('[gd_scene load_steps=3 format=3]\n\n[ext_resource type="Script" path="res://src/a.gd" id="1"]\n[ext_resource type="PackedScene" path="res://scenes/b.tscn" id="2"]\n[ext_resource type="Texture2D" path="res://art/t.png" id="3"]\n')) === JSON.stringify(['res://src/a.gd', 'res://scenes/b.tscn']))
  check('script mode is read from the head: extends SceneTree or MainLoop', gate.isScriptModeHead('extends SceneTree\n') && gate.isScriptModeHead('\nextends MainLoop\n') && !gate.isScriptModeHead('extends Node\n'))
  const scratch = mkdtempSync(join(tmpdir(), 'engine-preload-'))
  try {
    mkdirSync(join(scratch, 'tests'))
    mkdirSync(join(scratch, 'src'))
    writeFileSync(join(scratch, 'tests', 'suite.gd'), 'extends SceneTree\n\nconst Scene := preload("res://src/thing.tscn")\n\nfunc _initialize() -> void:\n\tquit()\n')
    writeFileSync(join(scratch, 'src', 'thing.tscn'), '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://src/thing.gd" id="1"]\n')
    writeFileSync(join(scratch, 'src', 'thing.gd'), 'extends Node\n\nconst Deep := preload("res://src/deep.gd")\n')
    writeFileSync(join(scratch, 'src', 'deep.gd'), 'extends RefCounted\n\nfunc go() -> void:\n\tGameState.save()\n')
    const findings = gate.preloadFindings(scratch, 'res://tests/suite.gd', ['Events', 'GameState'])
    check('a chain suite → scene → script → script that names an autoload is one finding with the whole chain', findings.length === 1 && findings[0].autoload === 'GameState' && findings[0].target === 'res://src/deep.gd' && findings[0].targetLine === 4 && findings[0].line === 3 && findings[0].chain.join(' → ') === 'res://tests/suite.gd → res://src/thing.tscn → res://src/thing.gd → res://src/deep.gd', JSON.stringify(findings))
    check('a suite with no autoload in its graph has no finding', gate.preloadFindings(scratch, 'res://tests/suite.gd', ['Nope']).length === 0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('5. the words: the optable rows and the prompt')
{
  const names = ['engine_run', 'engine_check', 'engine_jobs', 'engine_cancel', 'engine_result']
  check('the five ops sit in the frontier with their classes', names.every(n => optable.vulcanOp(n)?.category === 'frontier') && optable.vulcanOp('engine_check')?.cls === 'exec' && optable.vulcanOp('engine_result')?.cls === 'read')
  check('engine_check\'s row promises the exact autoload rule and the preload flag', /ignored exactly/.test(optable.vulcanOp('engine_check')?.summary ?? '') && /preload graph/.test(optable.vulcanOp('engine_check')?.summary ?? ''))
  const prompt = promptMod.getGodotToolDescription()
  check('the tool prompt teaches engine_run and engine_check as the engine job service', /engine_run/.test(prompt) && /engine_check/.test(prompt) && /frozen copy/.test(prompt) && /verifier > fold-gate > lane-gate > profile/.test(prompt))
  check('the prompt\'s catalog lists the ops', /engine_run\(suites\?/.test(prompt) && /engine_cancel\(id\)/.test(prompt))
}

section('6. the live gate on the fixture')
const godotEnv = process.env.GODOT_BIN
const receipt = godotEnv ? { resolved: godotEnv } : await doctorMod.resolveGodotExecutable({ census: [] })
if (!receipt.resolved) {
  console.log('  SKIP — no godot binary on PATH (set GODOT_BIN=…); the live legs need Godot 4')
} else {
  const godot: string = receipt.resolved
  const scratch = mkdtempSync(join(tmpdir(), 'engine-check-'))
  const P = join(scratch, 'game')
  cpSync(FIXTURE, P, { recursive: true })
  mkdirSync(join(P, '.mercury'), { recursive: true })
  cpSync(join(FIXTURE, 'engine-suites.json'), join(P, '.mercury', 'engine-suites.json'))
  const git = (...a: string[]): string => execFileSync('git', ['-C', P, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  const commit = git('rev-parse', 'HEAD').trim()
  const engineProcs = async (): Promise<number[]> => spawnMod.engineProcessesFor(P, await censusMod.runningGodotProcesses()).map((p: { pid: number }) => p.pid)
  try {
    pathsMod.ensureEngineEstate(P)
    const userDir = join(scratch, 'import-user')
    mkdirSync(userDir, { recursive: true })
    const imp = spawnMod.spawnEngine({ executable: godot, args: argvMod.engineImportArgv(P), cwd: P, userDir, timeoutMs: 180_000, label: 'import' })
    const impOut = await imp.done
    check('the live project imports once so its class cache exists (as an operator\'s editor would leave it)', impOut.exitCode === 0 && existsSync(join(P, '.godot', 'global_script_class_cache.cfg')))
    const opts = { executable: godot }

    const clean = await gate.runEngineCheck(P, {}, opts)
    check('a clean working tree: no script or shader diagnostics; only the manifest\'s preload finding', clean.checked.scripts.length === 0 && clean.diagnostics.length === 1 && clean.diagnostics[0].class === 'preload-reaches-autoload' && clean.ok === false, JSON.stringify(clean.diagnostics))
    const finding = clean.diagnostics[0]
    check('the finding names the suite, its preload line, the reached script and the autoload', finding.file === 'res://tests/preload_checks.gd' && finding.line === 3 && /res:\/\/src\/autoload_user\.gd/.test(finding.message) && /autoload Events \(line 4\)/.test(finding.message) && /Identifier not found: Events/.test(finding.message))

    writeFileSync(join(P, 'src/probe.gd'), 'class_name Probe\nextends RefCounted\n\nfunc count() -> int\n\treturn 3\n')
    writeFileSync(join(P, 'shaders/probe.gdshader'), 'shader_type canvas_item;\n\nvoid fragment() {\n\tCOLOR = vec4(UV, 0.0);\n}\n')
    const changed = await gate.runEngineCheck(P, {}, opts)
    const parse = changed.diagnostics.find((d: { class: string }) => d.class === 'parse-error')
    const shader = changed.diagnostics.find((d: { class: string }) => d.class === 'shader-error')
    check('the changed files against HEAD are the ones checked', changed.checked.scripts.join() === 'res://src/probe.gd' && changed.checked.shaders.join() === 'res://shaders/probe.gdshader')
    check('the deliberate parse error is reported with its file and line (the indented line after the colon-less def), attributed uncommitted', parse && parse.file === 'res://src/probe.gd' && parse.line === 5 && /Unexpected "Indent"/.test(parse.message) && parse.lastChange === 'uncommitted', JSON.stringify(parse))
    check('the broken shader is reported with its file and line, attributed uncommitted', shader && shader.file === 'res://shaders/probe.gdshader' && shader.line === 4 && /vec4\(vec2,float\)/.test(shader.message) && shader.lastChange === 'uncommitted', JSON.stringify(shader))
    check('the gate answers in seconds', changed.seconds < 30 && changed.ok === false, `seconds ${changed.seconds}`)
    const frozen = await gate.runEngineCheck(P, { files: ['src/probe.gd'], tree: 'HEAD' }, opts)
    check('the same file checked on a frozen HEAD copy is clean: the live half-edit is not seen', frozen.tree === 'HEAD' && !frozen.diagnostics.some((d: { file: string }) => d.file === 'res://src/probe.gd'), JSON.stringify(frozen.diagnostics))
    git('checkout', '--', 'src/probe.gd', 'shaders/probe.gdshader')

    const named = await gate.runEngineCheck(P, { files: ['src/autoload_user.gd', 'tests/scene_checks.gd', 'res://src/broken.gd', 'shaders/broken.gdshader'] }, opts)
    check('named files: the autoload identifier is ignored in both users, and nothing else', named.ignored.length === 2 && named.ignored.every((i: { autoload: string }) => i.autoload === 'Events') && !named.diagnostics.some((d: { file: string }) => d.file === 'res://src/autoload_user.gd' || d.file === 'res://tests/scene_checks.gd'), JSON.stringify({ ignored: named.ignored, diagnostics: named.diagnostics }))
    check('the class_name script resolves through the class cache (Probe is not a missing identifier)', !named.diagnostics.some((d: { message: string }) => /"Probe"/.test(d.message)))
    const broken = named.diagnostics.find((d: { file: string }) => d.file === 'res://src/broken.gd')
    check('a committed broken script is attributed to its commit and author', broken && broken.class === 'parse-error' && broken.line === 4 && typeof broken.lastChange === 'string' && broken.lastChange.startsWith(commit.slice(0, 12)) && /fixture/.test(broken.lastChange), JSON.stringify(broken))
    const brokenShader = named.diagnostics.find((d: { file: string }) => d.file === 'res://shaders/broken.gdshader')
    check('the committed broken shader compiles red at line 4', brokenShader && brokenShader.class === 'shader-error' && brokenShader.line === 4)
    check('the check leaves no probe or tree behind under .mercury/engine/checks', !existsSync(pathsMod.engineChecksDir(P)) || readdirSync(pathsMod.engineChecksDir(P)).length === 0)

    const viaOp = JSON.parse(await opsMod.runEngineOp('engine_check', { files: 'src/autoload_user.gd', shaders: false }, P))
    check('op:"engine_check" answers the same data', viaOp.ignored.length === 1 && viaOp.checked.shaders.length === 0 && Array.isArray(viaOp.diagnostics))
    const bad = await gate.runEngineCheck(P, { files: ['../outside.gd'] }, opts)
    check('a file outside the project is refused with a teaching line', /outside the project/.test(bad.teaching ?? ''))
  } finally {
    check('every engine the proof started is gone', (await engineProcs()).length === 0)
    rmSync(scratch, { recursive: true, force: true })
  }
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '✅ engine check proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
