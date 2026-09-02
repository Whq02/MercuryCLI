// ============================================================================
//  ide/launchProfiles — ONE typed launch-profile model shared by tests,
//  builds and debugging. Discovery EXECUTES NOTHING: it
//  reads the sources that already exist and normalizes only fields that map
//  TRUTHFULLY onto Mercury's own machinery — everything else is dropped
//  with its reason recorded on the profile (never silently).
//
//  Sources (each bounded, each independent — a broken source degrades to a
//  typed sourceError, never a lost discovery):
//    · .vscode/launch.json — the SAFE subset: type python/debugpy
//      (program|module + args + cwd) and type lldb/cppdbg/lldb-dap
//      (program + args). JSONC tolerated (comments + trailing commas
//      stripped bounded); unrepresentable configurations are LISTED with
//      the exact reason.
//    · python tests — the detected framework (services/ide/pythonTests):
//      a run-all profile, plus a rerun-failed profile when the latest
//      durable record carries failures.
//    · CMake — one build profile per non-hidden configure preset
//      (services/ide/cppProject), plus the conventional-configure profile
//      when NO presets exist (the documented remedy, never policy invention).
//    · Godot — main/current/*.tscn scene profiles
//      (services/ide/godotSession.discoverGodotLaunchProfiles).
//    · Unity — headless -batchmode test/build shapes (MERCURY_UNITY opt-in,
//      Unity-root gated; operator-run payloads — the tool refuses WITH the
//      exact command + the license disclaimer, executing nothing).
//    · Blender — headless --background render/python shapes
//      (MERCURY_BLENDER opt-in; the same operator-run contract, with the
//      argument-ORDER law encoded: output before frame).
//
//  Identity: profile ids are CONTENT-STABLE (`lp-<sha256-12>` over
//  source+kind+the action payload) — two discoveries of the same tree agree,
//  and a changed payload is a NEW id (an agent can never fire a stale one
//  silently). Execution belongs to the Launch tool: debug/run ride the
//  owner-addressed DAP machinery (run = DAP noDebug — one path, all lanes),
//  test rides the Test transactions, build rides the cpp build primitives.
//
//  Gate: MERCURY_LAUNCH (default-on, registered).
//  Proof: scripts/ide/prove-launch-profiles.ts.
// ============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { findGodotProjectRoot } from '../lsp/godotLane.js'
import { buildCppProjectProfile } from './cppProject.js'
import { discoverGodotLaunchProfiles } from './godotSession.js'
import {
  buildUnityProjectProfile,
  mercuryUnityEnabled,
  unityTestResultsPath,
  UNITY_LICENSE_DISCLAIMER,
} from './unityProject.js'
import {
  buildBlenderContextProfile,
  mercuryBlenderEnabled,
} from './blenderProject.js'
import {
  findPythonProjectRoot,
  buildPythonProjectProfile,
} from './pythonProject.js'
import { latestRun, probePytest } from './pythonTests.js'

export function launchProfilesEnabled(): boolean {
  return flagEnabled('MERCURY_LAUNCH')
}

export type LaunchProfileSource = 'vscode' | 'python-tests' | 'cmake' | 'godot' | 'unity' | 'blender' | 'runners'
export type LaunchProfileKind = 'debug' | 'run' | 'test' | 'build'

export interface LaunchProfile {
  /** Content-stable id: lp-<sha256-12> over source+kind+payload. */
  id: string
  source: LaunchProfileSource
  kind: LaunchProfileKind
  label: string
  language: 'python' | 'cpp' | 'js' | 'go' | 'dotnet' | 'ruby' | 'godot' | 'unity' | 'blender' | 'other'
  /** debug/run payload — consumed by the DAP machinery (run = noDebug). */
  debug?: {
    adapter: string
    program: string
    args?: string[]
    cwd?: string
  }
  /** test payload — consumed by the Test transactions. */
  test?: { framework: 'pytest' | 'unittest'; selection: string[]; selectionLabel: string }
  /** build payload — consumed by the cpp build primitives. */
  build?: { preset?: string; conventional?: boolean }
  /** godot scene payload — consumed via the godot DAP adapter contract. */
  godotScene?: { scene: string; path?: string }
  /** unity headless payload — OPERATOR-RUN (discovery executes nothing and
   *  the Launch tool refuses WITH this exact command: HEADLESS editor runs
   *  are the operator's act by design; the IN-PRODUCT executor is the
   *  `Unity` tool's tests_run over the bridge — in-editor, landed
   *  2026-08-29 — which writes the same results-XML door). `note` carries
   *  the license disclaimer sentence that rides every unity docs/refusal
   *  surface. */
  unityHeadless?: {
    /** The located editor executable, when one matched (else the operator
     *  substitutes their own — the commandLine spells a placeholder). */
    editorPath?: string
    /** Exact editor arguments (argv after the binary). */
    args: string[]
    /** The full teaching spelling the refusal/docs surfaces print. */
    commandLine: string
    note: string
  }
  /** blender headless payload — the same OPERATOR-RUN contract as
   *  unityHeadless (no license disclaimer: Blender needs none; the note
   *  teaches the argument-ORDER law and the hermetic --factory-startup
   *  road instead). The in-product executor landed (the
   *  `Blender` tool's python_run/render_still); headless stays
   *  operator-run here. */
  blenderHeadless?: {
    blenderPath?: string
    args: string[]
    commandLine: string
    note: string
  }
  /** runner payload — consumed by projectRunners.runRunnerProfile. */
  runnerRef?: { profileId: string; runner: string }
  /** Where this profile came from (file / detector). */
  provenance: string
  /** Source fields that could NOT be represented truthfully (honesty). */
  droppedFields?: string[]
}

export interface LaunchDiscovery {
  profiles: LaunchProfile[]
  /** launch.json configurations that could not be represented, with reasons. */
  skipped: Array<{ name: string; reason: string }>
  /** Per-source failures (typed, never thrown). */
  sourceErrors: Array<{ source: LaunchProfileSource; error: string }>
  collectedAt: number
}

const PROFILE_CAP = 80

function profileId(source: string, kind: string, payload: unknown): string {
  const digest = createHash('sha256')
    .update(`${source}\n${kind}\n${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 12)
  return `lp-${digest}`
}

// ── .vscode/launch.json (the SAFE subset) ────────────────────────────────────

/** Bounded JSONC → JSON: strip block and line comments outside strings,
 *  then trailing commas. Good enough for real launch.json files; a parse
 *  failure is a typed sourceError, never a throw. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        if (next !== undefined) {
          out += next
          i++
        }
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  // Trailing commas before } or ] (outside strings by construction now).
  return out.replace(/,(\s*[}\]])/g, '$1')
}

interface VsCodeConfig {
  name?: string
  type?: string
  request?: string
  program?: string
  module?: string
  args?: unknown
  cwd?: string
  [key: string]: unknown
}

/** ${workspaceFolder} is the ONE macro we expand (the overwhelmingly common
 *  case); any other ${…} macro makes the field unrepresentable. */
function expandVsCodeVar(value: string, root: string): string | null {
  const expanded = value.replaceAll('${workspaceFolder}', root)
  return expanded.includes('${') ? null : expanded
}

const VSCODE_PY_TYPES = new Set(['python', 'debugpy'])
const VSCODE_NATIVE_TYPES = new Set(['lldb', 'lldb-dap', 'cppdbg'])
/** One type family per SHIPPED adapter row (FN-013 IDE-06): the DAP
 *  registry carries js (vendored js-debug), go (dlv), dotnet (netcoredbg)
 *  and ruby (rdbg) beside python and lldb — launch.json translation used
 *  to cover the first two families only, so an ordinary Node, Go or .NET
 *  repository whose configuration Mercury is fully equipped to execute was
 *  reported as not representable (node/pwa-node being the most common
 *  configuration type in circulation). Field discipline is unchanged:
 *  the same bounded macro subset, discovery executes nothing, ids stay
 *  content-stable, unrepresentable configurations still list with their
 *  exact reason. */
const VSCODE_TYPE_FAMILIES: ReadonlyArray<{
  types: Set<string>
  adapter: string
  language: LaunchProfile['language']
}> = [
  { types: VSCODE_PY_TYPES, adapter: 'python', language: 'python' },
  { types: VSCODE_NATIVE_TYPES, adapter: 'lldb', language: 'cpp' },
  { types: new Set(['node', 'pwa-node']), adapter: 'js', language: 'js' },
  { types: new Set(['go']), adapter: 'go', language: 'go' },
  { types: new Set(['coreclr', 'dotnet']), adapter: 'dotnet', language: 'dotnet' },
  { types: new Set(['ruby', 'rdbg']), adapter: 'ruby', language: 'ruby' },
]
const REPRESENTED_FIELDS = new Set(['name', 'type', 'request', 'program', 'module', 'args', 'cwd'])

function vscodeProfiles(root: string): {
  profiles: LaunchProfile[]
  skipped: Array<{ name: string; reason: string }>
  error?: string
} {
  const file = path.join(root, '.vscode', 'launch.json')
  if (!existsSync(file)) return { profiles: [], skipped: [] }
  let configs: VsCodeConfig[]
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(file, 'utf8'))) as { configurations?: VsCodeConfig[] }
    configs = Array.isArray(parsed.configurations) ? parsed.configurations : []
  } catch (e) {
    return { profiles: [], skipped: [], error: `launch.json unparseable: ${e instanceof Error ? e.message : String(e)}` }
  }
  const profiles: LaunchProfile[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  for (const config of configs) {
    const name = config.name ?? '(unnamed)'
    const type = config.type ?? ''
    if (config.request !== 'launch') {
      skipped.push({ name, reason: `request '${config.request ?? '(none)'}' — only launch maps (attach rides the Debug tool directly)` })
      continue
    }
    const family = VSCODE_TYPE_FAMILIES.find(f => f.types.has(type))
    if (family === undefined) {
      skipped.push({ name, reason: `type '${type}' has no Mercury adapter mapping` })
      continue
    }
    const isPy = VSCODE_PY_TYPES.has(type)
    if (isPy && config.module !== undefined) {
      skipped.push({ name, reason: 'module launches are not yet representable (use a program path)' })
      continue
    }
    if (typeof config.program !== 'string' || config.program === '') {
      skipped.push({ name, reason: 'no program path' })
      continue
    }
    const program = expandVsCodeVar(config.program, root)
    if (program === null) {
      skipped.push({ name, reason: `program carries an unexpanded macro: ${config.program}` })
      continue
    }
    const args = Array.isArray(config.args) && config.args.every(a => typeof a === 'string') ? (config.args as string[]) : undefined
    const cwd = typeof config.cwd === 'string' ? expandVsCodeVar(config.cwd, root) : root
    if (cwd === null) {
      skipped.push({ name, reason: `cwd carries an unexpanded macro: ${String(config.cwd)}` })
      continue
    }
    const dropped = Object.keys(config).filter(k => !REPRESENTED_FIELDS.has(k))
    const payload = {
      adapter: family.adapter,
      program: path.isAbsolute(program) ? program : path.join(root, program),
      ...(args ? { args } : {}),
      cwd,
    }
    profiles.push({
      id: profileId('vscode', 'debug', payload),
      source: 'vscode',
      kind: 'debug',
      label: name,
      language: family.language,
      debug: payload,
      provenance: `.vscode/launch.json → "${name}" (type ${type})`,
      ...(dropped.length ? { droppedFields: dropped } : {}),
    })
  }
  return { profiles, skipped }
}

// ── the discovery ────────────────────────────────────────────────────────────

export async function discoverLaunchProfiles(from: string = getCwd()): Promise<LaunchDiscovery> {
  const profiles: LaunchProfile[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  const sourceErrors: Array<{ source: LaunchProfileSource; error: string }> = []

  // vscode (rooted at the broadest project truth we have: python root wins,
  // else the raw cwd — launch.json lives beside the workspace root).
  const pyRoot = findPythonProjectRoot(from).root
  try {
    const vs = vscodeProfiles(pyRoot)
    profiles.push(...vs.profiles)
    skipped.push(...vs.skipped)
    if (vs.error) sourceErrors.push({ source: 'vscode', error: vs.error })
  } catch (e) {
    sourceErrors.push({ source: 'vscode', error: e instanceof Error ? e.message : String(e) })
  }

  // python tests — profiles only when the interpreter is viable.
  try {
    const pyProfile = buildPythonProjectProfile(from)
    if (pyProfile.interpreter.state === 'ok') {
      const framework: 'pytest' | 'unittest' =
        pyProfile.testFrameworks.pytest.detected && probePytest(from).available ? 'pytest' : 'unittest'
      const runAll = { framework, selection: [] as string[], selectionLabel: 'all' }
      profiles.push({
        id: profileId('python-tests', 'test', runAll),
        source: 'python-tests',
        kind: 'test',
        label: `run all tests (${framework})`,
        language: 'python',
        test: runAll,
        provenance: `detected ${framework}${pyProfile.testFrameworks.pytest.evidence ? ` (${pyProfile.testFrameworks.pytest.evidence})` : ''} on ${pyProfile.interpreter.command}`,
      })
      const latest = latestRun(from)
      // runner-lane records rerun through projectRunners, not this payload
      if (latest && latest.failures.length > 0 && (latest.framework === 'pytest' || latest.framework === 'unittest')) {
        const rerun = { framework: latest.framework, selection: latest.failures, selectionLabel: 'rerun-failed' }
        profiles.push({
          id: profileId('python-tests', 'test', rerun),
          source: 'python-tests',
          kind: 'test',
          label: `rerun ${latest.failures.length} failure(s) from ${latest.id}`,
          language: 'python',
          test: rerun,
          provenance: `mercury://test/run/${latest.id}`,
        })
      }
    }
  } catch (e) {
    sourceErrors.push({ source: 'python-tests', error: e instanceof Error ? e.message : String(e) })
  }

  // cmake — a build profile per non-hidden configure preset; the conventional
  // configure only when NO presets exist (the documented remedy).
  try {
    const cpp = buildCppProjectProfile(from)
    if (cpp.cmake.lists) {
      if (cpp.cmake.presets.length > 0) {
        for (const preset of cpp.cmake.presets) {
          const payload = { preset: preset.name }
          profiles.push({
            id: profileId('cmake', 'build', payload),
            source: 'cmake',
            kind: 'build',
            label: `cmake preset ${preset.displayName ?? preset.name}`,
            language: 'cpp',
            build: payload,
            provenance: `${cpp.cmake.presetsFile ?? 'CMakePresets.json'} → "${preset.name}"`,
          })
        }
      } else {
        const payload = { conventional: true }
        profiles.push({
          id: profileId('cmake', 'build', payload),
          source: 'cmake',
          kind: 'build',
          label: 'cmake conventional configure (build/, compile_commands ON)',
          language: 'cpp',
          build: payload,
          provenance: `${cpp.cmake.lists} (no presets — the documented convention)`,
        })
      }
      if (cpp.cmake.presetsError) {
        sourceErrors.push({ source: 'cmake', error: cpp.cmake.presetsError })
      }
    }
  } catch (e) {
    sourceErrors.push({ source: 'cmake', error: e instanceof Error ? e.message : String(e) })
  }

  // godot — scene profiles through the slice-6 discovery (executes nothing).
  try {
    const godotRoot = findGodotProjectRoot(from)
    if (godotRoot) {
      const discovery = await discoverGodotLaunchProfiles(godotRoot)
      for (const scene of discovery.profiles) {
        const payload = { scene: scene.scene, ...(scene.path ? { path: scene.path } : {}) }
        profiles.push({
          id: profileId('godot', 'run', { root: godotRoot, ...payload }),
          source: 'godot',
          kind: 'run',
          label: scene.label,
          language: 'godot',
          godotScene: payload,
          debug: {
            adapter: 'godot',
            program: godotRoot,
            args: [scene.kind === 'main' ? 'main' : scene.kind === 'current' ? 'current' : scene.scene],
          },
          provenance: `godot ${scene.kind} scene (project ${godotRoot})`,
        })
      }
      if (discovery.truncatedScenes > 0) {
        sourceErrors.push({
          source: 'godot',
          error: `${discovery.truncatedScenes} scene(s) beyond the discovery cap were not profiled (bounded listing, not an error)`,
        })
      }
    }
  } catch (e) {
    sourceErrors.push({ source: 'godot', error: e instanceof Error ? e.message : String(e) })
  }

  // unity — headless -batchmode shapes, OPT-IN (MERCURY_UNITY) and
  // Unity-root gated; discovery EXECUTES NOTHING and the payload is
  // operator-run (the Launch tool refuses WITH the exact command — HEADLESS
  // editor runs stay the operator's act by design; the IN-PRODUCT executor
  // landed as the Unity tool's tests_run over the bridge, and
  // both roads write the one results-XML door). Flag facts read 2026-08-29 from
  // docs.unity3d.com 6000.3 (EditorCommandLineArguments +
  // test-framework/reference-command-line): test runs mirror the documented
  // example `-runTests -batchmode -projectPath … -testResults … -testPlatform …`
  // and NEVER carry -quit ("-quit command-line argument is not supported
  // while tests are running"); builds are the -batchmode -nographics -quit
  // -executeMethod shape with the method name the PROJECT owns (no policy
  // invention — the cmake conventional-configure lesson).
  try {
    if (mercuryUnityEnabled()) {
      const unity = buildUnityProjectProfile(from)
      if (unity.state === 'ok') {
        const editor = unity.projectEditor?.path
        const spell = (args: string[]): string =>
          [editor ?? '<unity-editor>', ...args]
            .map(a => (a.includes(' ') ? `"${a}"` : a))
            .join(' ')
        const mk = (
          kind: LaunchProfileKind,
          label: string,
          args: string[],
        ): LaunchProfile => {
          const payload = {
            ...(editor ? { editorPath: editor } : {}),
            args,
            commandLine: spell(args),
            note: UNITY_LICENSE_DISCLAIMER,
          }
          return {
            id: profileId('unity', kind, payload),
            source: 'unity',
            kind,
            label,
            language: 'unity',
            unityHeadless: payload,
            provenance: `unity project ${unity.root}${unity.projectVersion.version ? ` (m_EditorVersion ${unity.projectVersion.version})` : ''} — ${unity.editorDetail}`,
          }
        }
        for (const mode of ['EditMode', 'PlayMode'] as const) {
          profiles.push(
            mk(
              'test',
              `unity ${mode} tests (headless; results XML → .mercury/unity-test-results/${mode.toLowerCase()}.xml)`,
              [
                '-runTests',
                '-batchmode',
                '-projectPath',
                unity.root,
                '-testResults',
                unityTestResultsPath(unity.root, mode),
                '-testPlatform',
                mode,
              ],
            ),
          )
        }
        profiles.push(
          mk('build', 'unity headless build (-executeMethod: substitute the PROJECT\'S OWN static build method)', [
            '-batchmode',
            '-nographics',
            '-quit',
            '-projectPath',
            unity.root,
            '-executeMethod',
            '<Your.Editor.BuildMethod>',
            '-logFile',
            '-',
          ]),
        )
      }
    }
  } catch (e) {
    sourceErrors.push({ source: 'unity', error: e instanceof Error ? e.message : String(e) })
  }

  // blender — headless --background shapes, OPT-IN (MERCURY_BLENDER);
  // same operator-run contract as unity (discovery executes nothing; the
  // tool refuses WITH the exact command; the in-product executor is the
  // `Blender` tool — landed, headless stays operator-run
  // here). Flag facts read 2026-08-29 from Blender's own
  // creator/creator_args.cc + the 5.2 manual's ORDER law: "arguments are
  // executed in the order they are given" — the manual's own example shows
  // a -f before -o rendering to the WRONG place, so every render argv here
  // encodes output BEFORE frame. -o's '//' prefix = relative to the blend
  // file (the doc string); --factory-startup + --python-exit-code arm the
  // hermetic script road.
  try {
    if (mercuryBlenderEnabled()) {
      const ctx = buildBlenderContextProfile(from)
      const bin = ctx.blender?.path
      const spell = (args: string[]): string =>
        [bin ?? '<blender>', ...args].map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')
      const mkB = (kind: LaunchProfileKind, label: string, args: string[], note: string): LaunchProfile => {
        const payload = {
          ...(bin ? { blenderPath: bin } : {}),
          args,
          commandLine: spell(args),
          note,
        }
        return {
          id: profileId('blender', kind, payload),
          source: 'blender',
          kind,
          label,
          language: 'blender',
          blenderHeadless: payload,
          provenance: `blender context at ${ctx.from} — ${ctx.detail}`,
        }
      }
      const ORDER_NOTE =
        'blender arguments execute IN ORDER (output is set before the frame renders — reversed, the render lands in the wrong place); runs are yours to start: Mercury locates but never launches Blender.'
      const BLEND_PROFILE_FILE_CAP = 10
      for (const rel of ctx.blendFiles.files.slice(0, BLEND_PROFILE_FILE_CAP)) {
        const abs = path.join(ctx.from, rel)
        profiles.push(
          mkB('run', `blender render frame 1 — ${rel}`, ['-b', abs, '-o', '//render/', '-f', '1'], ORDER_NOTE),
        )
        profiles.push(
          mkB('run', `blender render animation — ${rel}`, ['-b', abs, '-o', '//render/', '-a'], ORDER_NOTE),
        )
      }
      if (ctx.blendFiles.files.length > BLEND_PROFILE_FILE_CAP) {
        sourceErrors.push({
          source: 'blender',
          error: `${ctx.blendFiles.files.length - BLEND_PROFILE_FILE_CAP} more .blend file(s) beyond the profile cap were not profiled (bounded listing, not an error)`,
        })
      }
      profiles.push(
        mkB(
          'run',
          'blender hermetic python run (--factory-startup: substitute YOUR script)',
          ['--background', '--factory-startup', '--python', '<your-script.py>', '--python-exit-code', '1'],
          'hermetic run: --factory-startup skips the user startup.blend; --python-exit-code 1 makes a raised Python exception exit 1 (zero disables — the doc string). Runs are yours to start.',
        ),
      )
      // The debug road: a RECIPE row riding the LANDED debugpy attach
      // contract — the listener side is the operator's one line, the attach
      // side is the Debug tool's python adapter (no new machinery; the
      // upstream --listen wedge cited in the steps).
      const { blenderDebugRecipe } = await import('./blenderDebug.js')
      const recipe = blenderDebugRecipe(bin ?? '<blender>')
      profiles.push(
        mkB(
          'debug',
          `blender debugpy attach recipe (listen :${recipe.port}, then Debug attach — ${recipe.debugpySource} debugpy)`,
          ['--python-expr', recipe.expr],
          recipe.steps.join('\n'),
        ),
      )
    }
  } catch (e) {
    sourceErrors.push({ source: 'blender', error: e instanceof Error ? e.message : String(e) })
  }

  // runners — the polyglot registry (JS/TS · cargo · go) joins as a
  // source; execution stays with the Test transactions / runRunnerProfile.
  try {
    const { discoverRunnerProfiles } = await import('./projectRunners.js')
    const { profiles: runnerProfiles } = discoverRunnerProfiles(from)
    for (const r of runnerProfiles) {
      profiles.push({
        id: profileId('runners', r.kind, { rp: r.id, cmd: r.command }),
        source: 'runners',
        kind: r.kind === 'check' ? 'build' : r.kind,
        label:
          r.availability.state === 'ok'
            ? r.title
            : `${r.title} (unavailable: ${r.availability.reason})`,
        language: 'other',
        runnerRef: { profileId: r.id, runner: r.runner },
        provenance: `${r.source} (${r.runner})`,
      })
    }
  } catch (e) {
    sourceErrors.push({ source: 'runners', error: e instanceof Error ? e.message : String(e) })
  }

  return {
    profiles: profiles.slice(0, PROFILE_CAP),
    skipped,
    sourceErrors,
    collectedAt: Date.now(),
  }
}

export async function getLaunchProfile(id: string, from: string = getCwd()): Promise<LaunchProfile | null> {
  const discovery = await discoverLaunchProfiles(from)
  return discovery.profiles.find(p => p.id === id) ?? null
}
