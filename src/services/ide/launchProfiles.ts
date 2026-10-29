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
import { hasPythonTestFiles } from './projectRunners.js'
import { resolvePreLaunchTask, type PreLaunchTask } from './launchTasks.js'

export function launchProfilesEnabled(): boolean {
  return flagEnabled('MERCURY_LAUNCH')
}

type LaunchProfileSource = 'vscode' | 'python-tests' | 'cmake' | 'godot' | 'unity' | 'blender' | 'runners'
type LaunchProfileKind = 'debug' | 'run' | 'test' | 'build'

export interface LaunchProfile {

  id: string
  source: LaunchProfileSource
  kind: LaunchProfileKind
  label: string
  language: 'python' | 'cpp' | 'js' | 'go' | 'dotnet' | 'ruby' | 'godot' | 'unity' | 'blender' | 'other'

  debug?: {
    adapter: string
    program: string
    module?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    envSource?: string
  }
  attach?: {
    adapter: string
    host?: string
    port?: number
    pid?: number
  }

  test?: { framework: 'pytest' | 'unittest'; selection: string[]; selectionLabel: string }

  build?: { preset?: string; conventional?: boolean }

  godotScene?: { scene: string; path?: string }

  unityHeadless?: {

    editorPath?: string

    args: string[]

    commandLine: string
    note: string
  }

  blenderHeadless?: {
    blenderPath?: string
    args: string[]
    commandLine: string
    note: string
  }

  runnerRef?: { profileId: string; runner: string }
  preLaunchTask?: PreLaunchTask

  provenance: string

  droppedFields?: string[]
}

interface LaunchDiscovery {
  profiles: LaunchProfile[]

  skipped: Array<{ name: string; reason: string }>

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
  env?: unknown
  envFile?: unknown
  preLaunchTask?: unknown
  connect?: unknown
  listen?: unknown
  processId?: unknown
  pid?: unknown
  port?: unknown
  host?: unknown
  address?: unknown
  [key: string]: unknown
}

export function expandVsCodeVar(value: string, root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const expanded = value.replaceAll('${workspaceFolder}', root).replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '')
  return expanded.includes('${') ? null : expanded
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n')
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    out[m[1]!] = value
  }
  return out
}

function configEnvironment(
  config: VsCodeConfig,
  root: string,
): { env?: Record<string, string>; envSource?: string; skip?: string } {
  const merged: Record<string, string> = {}
  const sources: string[] = []
  if (config.envFile !== undefined) {
    if (typeof config.envFile !== 'string' || config.envFile === '') return { skip: 'envFile is not a path' }
    const expanded = expandVsCodeVar(config.envFile, root)
    if (expanded === null) return { skip: `envFile carries an unexpanded macro: ${config.envFile}` }
    const file = path.isAbsolute(expanded) ? expanded : path.join(root, expanded)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { skip: `envFile not found: ${file}` }
    }
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      const resolved = expandVsCodeVar(value, root)
      if (resolved === null) return { skip: `envFile ${path.relative(root, file)}: ${key} carries an unexpanded macro` }
      merged[key] = resolved
    }
    sources.push(path.relative(root, file) || file)
  }
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) return { skip: 'env is not an object of strings' }
    for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
      if (value === null) {
        delete merged[key]
        continue
      }
      if (typeof value !== 'string') return { skip: `env ${key} is not a string` }
      const resolved = expandVsCodeVar(value, root)
      if (resolved === null) return { skip: `env ${key} carries an unexpanded macro: ${value}` }
      merged[key] = resolved
    }
    sources.unshift('launch.json env')
  }
  if (sources.length === 0) return {}
  return { env: merged, envSource: sources.length === 2 ? `${sources[0]} over ${sources[1]}` : sources[0]! }
}

const VSCODE_PY_TYPES = new Set(['python', 'debugpy'])
const VSCODE_NATIVE_TYPES = new Set(['lldb', 'lldb-dap', 'cppdbg'])

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
const REPRESENTED_FIELDS = new Set(['name', 'type', 'request', 'program', 'module', 'args', 'cwd', 'env', 'envFile', 'preLaunchTask'])
const ATTACH_FIELDS = new Set(['name', 'type', 'request', 'connect', 'port', 'host', 'address', 'processId', 'pid', 'mode', 'preLaunchTask'])

function attachTarget(config: VsCodeConfig): { host?: string; port?: number; pid?: number } | { skip: string } {
  const asPort = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535 ? value : typeof value === 'string' && /^\d+$/.test(value) ? asPort(Number(value)) : null)
  const connect = config.connect
  if (connect !== undefined) {
    if (!connect || typeof connect !== 'object') return { skip: 'connect is not an object' }
    const port = asPort((connect as { port?: unknown }).port)
    if (port === null) return { skip: 'connect carries no port' }
    const host = (connect as { host?: unknown }).host
    return { port, ...(typeof host === 'string' && host !== '' ? { host } : {}) }
  }
  if (config.listen !== undefined) return { skip: 'attach with listen (the program dials the editor) is not representable — use connect, or attach with the Debug tool' }
  const rawPid = config.processId ?? config.pid
  if (rawPid !== undefined) {
    if (typeof rawPid === 'string' && rawPid.includes('${')) return { skip: `processId carries a macro Mercury cannot resolve: ${rawPid} — attach with the Debug tool and pass the pid` }
    const pid = asPort(rawPid)
    if (pid === null) return { skip: 'processId is not a process id' }
    return { pid }
  }
  if (config.port !== undefined) {
    const port = asPort(config.port)
    if (port === null) return { skip: 'port is not a port number' }
    const host = config.host ?? config.address
    return { port, ...(typeof host === 'string' && host !== '' ? { host } : {}) }
  }
  return { skip: 'attach needs a port (with an optional host) or a process id' }
}

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
    const family = VSCODE_TYPE_FAMILIES.find(f => f.types.has(type))
    if (family === undefined) {
      skipped.push({ name, reason: `type '${type}' has no Mercury adapter mapping` })
      continue
    }
    if (config.request === 'attach') {
      const target = attachTarget(config)
      if ('skip' in target) {
        skipped.push({ name, reason: target.skip })
        continue
      }
      const payload = { adapter: family.adapter, ...target }
      const dropped = Object.keys(config).filter(k => !ATTACH_FIELDS.has(k))
      profiles.push({
        id: profileId('vscode', 'attach', payload),
        source: 'vscode',
        kind: 'debug',
        label: name,
        language: family.language,
        attach: payload,
        provenance: `.vscode/launch.json → "${name}" (type ${type}, attach)`,
        ...(dropped.length ? { droppedFields: dropped } : {}),
      })
      continue
    }
    if (config.request !== 'launch') {
      skipped.push({ name, reason: `request '${config.request ?? '(none)'}' is neither launch nor attach` })
      continue
    }
    const isPy = VSCODE_PY_TYPES.has(type)
    const module = isPy && typeof config.module === 'string' && config.module !== '' ? config.module : null
    if (module === null && (typeof config.program !== 'string' || config.program === '')) {
      skipped.push({ name, reason: isPy ? 'no program path or module' : 'no program path' })
      continue
    }
    const program = module !== null ? `-m ${module}` : expandVsCodeVar(config.program as string, root)
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
    const environment = configEnvironment(config, root)
    if (environment.skip !== undefined) {
      skipped.push({ name, reason: environment.skip })
      continue
    }
    const dropped = Object.keys(config).filter(k => !REPRESENTED_FIELDS.has(k))
    const payload = {
      adapter: family.adapter,
      program: module !== null || path.isAbsolute(program) ? program : path.join(root, program),
      ...(module !== null ? { module } : {}),
      ...(args ? { args } : {}),
      cwd,
      ...(environment.env !== undefined ? { env: environment.env, envSource: environment.envSource } : {}),
    }
    const preLaunchTask =
      config.preLaunchTask === undefined
        ? undefined
        : typeof config.preLaunchTask === 'string' && config.preLaunchTask !== ''
          ? resolvePreLaunchTask(config.preLaunchTask, root)
          : { label: String(config.preLaunchTask), refused: 'preLaunchTask is not a task label' }
    profiles.push({
      id: profileId('vscode', 'debug', preLaunchTask ? { ...payload, preLaunchTask } : payload),
      source: 'vscode',
      kind: 'debug',
      label: name,
      language: family.language,
      debug: payload,
      ...(preLaunchTask ? { preLaunchTask } : {}),
      provenance: `.vscode/launch.json → "${name}" (type ${type})`,
      ...(dropped.length ? { droppedFields: dropped } : {}),
    })
  }
  return { profiles, skipped }
}

export async function discoverLaunchProfiles(from: string = getCwd()): Promise<LaunchDiscovery> {
  const profiles: LaunchProfile[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  const sourceErrors: Array<{ source: LaunchProfileSource; error: string }> = []

  const pyRoot = findPythonProjectRoot(from).root
  try {
    const vs = vscodeProfiles(pyRoot)
    profiles.push(...vs.profiles)
    skipped.push(...vs.skipped)
    if (vs.error) sourceErrors.push({ source: 'vscode', error: vs.error })
  } catch (e) {
    sourceErrors.push({ source: 'vscode', error: e instanceof Error ? e.message : String(e) })
  }

  try {
    const pyProfile = buildPythonProjectProfile(from)
    if (pyProfile.interpreter.state === 'ok' && ((pyProfile.testFrameworks.pytest.detected && probePytest(from).available) || hasPythonTestFiles(pyProfile.projectRoot))) {
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
              `unity ${mode} tests (headless; results XML → ${path.relative(unity.root, unityTestResultsPath(unity.root, mode))})`,
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
