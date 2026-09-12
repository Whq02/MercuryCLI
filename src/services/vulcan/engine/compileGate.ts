import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { classCacheReport } from '../classCache.js'
import { engineCheckOnlyArgv, engineScriptArgv } from './argv.js'
import {
  describeAttribution,
  engineFileAttribution,
  liveTreeFacts,
  materializeEngineTree,
  normalizeTreeFile,
  parseEngineTreeSpec,
  parsePorcelainZ,
  removeEngineTree,
  runGit,
  type EngineTreeFacts,
} from './frozenTree.js'
import { engineLogErrors, stripEngineAnsi } from './logs.js'
import { readEngineManifest, type EngineManifest } from './manifest.js'
import { MERCURY_PROJECT_DIR } from '../../../utils/projectConfig.js'
import { ENGINE_DIR_SEGMENT, engineChecksDir, ensureEngineEstate } from './paths.js'
import { engineWorkerCount, newEngineJobId } from './service.js'
import { spawnEngine } from './spawn.js'

export const ENGINE_CHECK_TIMEOUT_MS = 60_000
export const SHADER_MARKER_PREFIX = 'MERCURY SHADER '
export const SHADER_DONE_LINE = 'MERCURY SHADER DONE'
export const WALK_CAP = 20_000

export type EngineDiagnosticClass = 'parse-error' | 'compile-error' | 'shader-error' | 'preload-reaches-autoload' | 'engine-error'

export interface EngineDiagnostic {
  file: string
  line: number | null
  message: string
  class: EngineDiagnosticClass
  lastChange: string | null
}

export interface EngineIgnoredLine {
  file: string
  line: number | null
  autoload: string
  message: string
}

export interface EngineCheckFailure {
  file: string
  exitCode: number | null
  signal: string | null
  spawnError: string | null
  timedOut: boolean
}

export interface EngineCheckArgs {
  files?: string[]
  all?: boolean
  tree?: unknown
  shaders?: boolean
  parallel?: number
}

export interface EngineCheckResult {
  ok: boolean
  root: string
  enginePath: string
  executable: string
  tree: string
  autoloads: string[]
  checked: { scripts: string[]; shaders: string[] }
  diagnostics: EngineDiagnostic[]
  ignored: EngineIgnoredLine[]
  failures: EngineCheckFailure[]
  seconds: number
  parallel: number
  classCache: string | null
  teaching: string | null
}

export function projectAutoloads(projectRoot: string): string[] {
  let text: string
  try {
    text = readFileSync(path.join(projectRoot, 'project.godot'), 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  let inAutoload = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inAutoload = line === '[autoload]'
      continue
    }
    if (!inAutoload || line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) out.push(line.slice(0, eq).trim())
  }
  return out
}

const AUTOLOAD_NOT_FOUND_RE = /^Compile Error: Identifier not found: ([A-Za-z_][A-Za-z0-9_]*)$/
const DEPENDED_RE = /^Compile Error: Failed to compile depended scripts\.?$/

export function classifyScriptError(message: string): EngineDiagnosticClass {
  if (message.startsWith('Parse Error:')) return 'parse-error'
  if (message.startsWith('Compile Error:')) return 'compile-error'
  return 'engine-error'
}

export interface CheckOnlyReading {
  diagnostics: Array<{ file: string; line: number | null; message: string; class: EngineDiagnosticClass }>
  ignored: EngineIgnoredLine[]
}

export function readCheckOnlyOutput(output: string, checkedRes: string, autoloads: readonly string[]): CheckOnlyReading {
  const diagnostics: CheckOnlyReading['diagnostics'] = []
  const ignored: EngineIgnoredLine[] = []
  const depended: CheckOnlyReading['diagnostics'] = []
  for (const e of engineLogErrors(output)) {
    if (e.kind === 'error') continue
    const file = e.file ?? checkedRes
    if (e.kind === 'shader-error') {
      diagnostics.push({ file, line: e.line, message: e.message, class: 'shader-error' })
      continue
    }
    const auto = AUTOLOAD_NOT_FOUND_RE.exec(e.message)
    if (auto && autoloads.includes(auto[1])) {
      ignored.push({ file, line: e.line, autoload: auto[1], message: e.message })
      continue
    }
    if (DEPENDED_RE.test(e.message)) {
      depended.push({ file, line: e.line, message: e.message, class: 'compile-error' })
      continue
    }
    diagnostics.push({ file, line: e.line, message: e.message, class: classifyScriptError(e.message) })
  }
  if (diagnostics.length > 0 || ignored.length === 0) diagnostics.push(...depended)
  else for (const d of depended) ignored.push({ file: d.file, line: d.line, autoload: ignored[0].autoload, message: `${d.message} (only autoload identifiers were missing)` })
  return { diagnostics, ignored }
}

export function readShaderCheckOutput(output: string): Array<{ file: string; line: number | null; message: string }> {
  const out: Array<{ file: string; line: number | null; message: string }> = []
  const lines = stripEngineAnsi(output).split(/\r?\n/)
  let current = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    if (line.startsWith(SHADER_MARKER_PREFIX) && !line.startsWith(SHADER_DONE_LINE)) {
      current = line.slice(SHADER_MARKER_PREFIX.length).replace(/^MISSING /, '').trim()
      if (line.startsWith(`${SHADER_MARKER_PREFIX}MISSING `)) out.push({ file: current, line: null, message: 'the shader did not load' })
      continue
    }
    const m = /^SHADER ERROR: (.*)$/.exec(line)
    if (!m) continue
    let at: number | null = null
    const next = lines[i + 1] ?? ''
    const atMatch = /\((?:[^()]*):(\d+)\)\s*$/.exec(next)
    if (atMatch) at = Number(atMatch[1])
    out.push({ file: current, line: at, message: m[1].trim() })
  }
  return out
}

export function shaderCheckScript(resPaths: readonly string[]): string {
  const list = resPaths.map(p => JSON.stringify(p)).join(', ')
  return [
    'extends SceneTree',
    '',
    `const SHADERS := [${list}]`,
    '',
    'func _initialize() -> void:',
    '\tfor p in SHADERS:',
    `\t\tprinterr("${SHADER_MARKER_PREFIX}%s" % p)`,
    '\t\tvar s = load(p)',
    '\t\tif s == null:',
    `\t\t\tprinterr("${SHADER_MARKER_PREFIX}MISSING %s" % p)`,
    '\t\telse:',
    '\t\t\tvar _uniforms = s.get_shader_uniform_list()',
    `\tprinterr("${SHADER_DONE_LINE}")`,
    '\tquit()',
    '',
  ].join('\n')
}

function stripGdNoise(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/#.*$/gm, '')
}

export function preloadTargets(text: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = []
  const lines = text.replace(/#.*$/gm, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/preload\(\s*"(res:\/\/[^"]+)"\s*\)/g)) out.push({ path: m[1], line: i + 1 })
  }
  return out
}

export function sceneScriptTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\[ext_resource[^\]]*type="(Script|PackedScene)"[^\]]*path="(res:\/\/[^"]+)"[^\]]*\]/g)) out.push(m[2])
  return out
}

export function autoloadMentions(text: string, autoloads: readonly string[]): Array<{ autoload: string; line: number }> {
  const out: Array<{ autoload: string; line: number }> = []
  const lines = stripGdNoise(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const name of autoloads) {
      if (new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`).test(lines[i])) out.push({ autoload: name, line: i + 1 })
    }
  }
  return out
}

export function isScriptModeHead(text: string): boolean {
  return /^\s*extends\s+(SceneTree|MainLoop)\b/m.test(text.slice(0, 4096))
}

export interface PreloadFinding {
  suite: string
  line: number
  chain: string[]
  target: string
  autoload: string
  targetLine: number
}

export function preloadFindings(enginePath: string, suiteRes: string, autoloads: readonly string[]): PreloadFinding[] {
  const readRes = (res: string): string | null => {
    try {
      return readFileSync(path.join(enginePath, res.replace(/^res:\/\//, '')), 'utf8')
    } catch {
      return null
    }
  }
  const root = readRes(suiteRes)
  if (root === null || autoloads.length === 0) return []
  const findings: PreloadFinding[] = []
  const seen = new Set<string>([suiteRes])
  const own = autoloadMentions(root, autoloads)
  for (const m of own) findings.push({ suite: suiteRes, line: m.line, chain: [suiteRes], target: suiteRes, autoload: m.autoload, targetLine: m.line })
  const queue: Array<{ res: string; line: number; chain: string[] }> = preloadTargets(root).map(t => ({ res: t.path, line: t.line, chain: [suiteRes] }))
  while (queue.length > 0) {
    const item = queue.shift()!
    if (seen.has(item.res)) continue
    seen.add(item.res)
    const text = readRes(item.res)
    if (text === null) continue
    const chain = [...item.chain, item.res]
    if (item.res.endsWith('.gd')) {
      for (const m of autoloadMentions(text, autoloads)) {
        findings.push({ suite: suiteRes, line: item.line, chain, target: item.res, autoload: m.autoload, targetLine: m.line })
      }
      for (const t of preloadTargets(text)) queue.push({ res: t.path, line: item.line, chain })
    } else if (item.res.endsWith('.tscn') || item.res.endsWith('.tres')) {
      for (const t of sceneScriptTargets(text)) queue.push({ res: t, line: item.line, chain })
    }
  }
  return findings
}

function walkFiles(root: string, suffixes: readonly string[]): string[] {
  const out: string[] = []
  let visited = 0
  const walk = (dir: string): void => {
    if (visited > WALK_CAP) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of entries) {
      if (visited++ > WALK_CAP) return
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (suffixes.some(s => name.endsWith(s))) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out
}

const SCRIPT_SUFFIXES = ['.gd']
const SHADER_SUFFIXES = ['.gdshader']
const SHADER_INCLUDE_SUFFIXES = ['.gdshaderinc']

export interface EngineCheckOptions {
  executable: string
  manifest?: EngineManifest
}

export async function runEngineCheck(projectRoot: string, args: EngineCheckArgs, opts: EngineCheckOptions): Promise<EngineCheckResult> {
  const t0 = Date.now()
  const manifest = opts.manifest ?? readEngineManifest(projectRoot)
  const parallel = Math.max(1, Math.min(16, args.parallel && Number.isInteger(args.parallel) ? args.parallel : engineWorkerCount().count))
  const spec = parseEngineTreeSpec(args.tree)
  const result: EngineCheckResult = {
    ok: false,
    root: projectRoot,
    enginePath: projectRoot,
    executable: opts.executable,
    tree: 'live',
    autoloads: [],
    checked: { scripts: [], shaders: [] },
    diagnostics: [],
    ignored: [],
    failures: [],
    seconds: 0,
    parallel,
    classCache: null,
    teaching: null,
  }
  if ('error' in spec) {
    result.teaching = spec.error
    result.seconds = Math.round((Date.now() - t0) / 100) / 10
    return result
  }
  ensureEngineEstate(projectRoot)
  const checkId = newEngineJobId()
  const checkDir = path.join(engineChecksDir(projectRoot), checkId)
  mkdirSync(checkDir, { recursive: true })
  let facts: Pick<EngineTreeFacts, 'commit' | 'baseBlobs' | 'overlay'>
  let enginePath = projectRoot
  let treePath: string | null = null
  const frozen = args.tree !== undefined && args.tree !== null && args.tree !== ''
  try {
    if (frozen) {
      treePath = path.join(checkDir, 'tree')
      const made = await materializeEngineTree(projectRoot, spec, treePath)
      if ('error' in made) {
        result.teaching = made.error
        return result
      }
      facts = made
      enginePath = treePath
      result.tree = spec.label
    } else {
      facts = await liveTreeFacts(projectRoot)
    }
    result.enginePath = enginePath
    result.autoloads = projectAutoloads(enginePath)
    let candidates: string[] = []
    if (Array.isArray(args.files) && args.files.length > 0) {
      for (const f of args.files) {
        const norm = typeof f === 'string' ? normalizeTreeFile(f) : null
        if (norm === null) {
          result.teaching = `file "${String(f)}" is outside the project (pass res:// or project-relative paths)`
          return result
        }
        candidates.push(norm)
      }
    } else if (args.all === true) {
      candidates = [...walkFiles(enginePath, SCRIPT_SUFFIXES), ...walkFiles(enginePath, SHADER_SUFFIXES)]
    } else if (frozen && spec.files.length > 0) {
      candidates = spec.files.map(f => normalizeTreeFile(f) ?? '').filter(f => f.length > 0)
    } else {
      const st = await runGit(projectRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'])
      candidates = st.code === 0 ? parsePorcelainZ(st.stdout).map(f => normalizeTreeFile(f) ?? '').filter(f => f.length > 0) : []
    }
    const present = (rel: string): boolean => existsSync(path.join(enginePath, rel))
    const scripts = [...new Set(candidates.filter(f => f.endsWith('.gd') && present(f)))]
    let shaders = [...new Set(candidates.filter(f => f.endsWith('.gdshader') && present(f)))]
    if (args.shaders !== false && candidates.some(f => SHADER_INCLUDE_SUFFIXES.some(s => f.endsWith(s)))) {
      shaders = [...new Set([...shaders, ...walkFiles(enginePath, SHADER_SUFFIXES)])]
    }
    if (args.shaders === false) shaders = []
    result.checked = { scripts: scripts.map(s => `res://${s}`), shaders: shaders.map(s => `res://${s}`) }
    const scriptSuites = manifest.suites.filter(s => s.script).map(s => `res://${manifest.defaults.suiteDir}/${s.name}.gd`)
    if (scripts.length === 0 && shaders.length === 0 && scriptSuites.length === 0) {
      result.teaching =
        Array.isArray(args.files) && args.files.length > 0
          ? 'none of the named files exist as .gd or .gdshader under the project'
          : 'no changed .gd or .gdshader files against HEAD (git status is clean) — pass files:[...] to check named files, or all:true for every script and shader'
      result.ok = true
      return result
    }
    const userDir = path.join(checkDir, 'user')
    mkdirSync(userDir, { recursive: true })
    const attribution = async (res: string): Promise<string | null> => {
      if (!res.startsWith('res://')) return null
      return describeAttribution(await engineFileAttribution(projectRoot, facts, res))
    }
    let cursor = 0
    const runNext = async (): Promise<void> => {
      while (cursor < scripts.length) {
        const rel = scripts[cursor++]
        const res = `res://${rel}`
        const handle = spawnEngine({
          executable: opts.executable,
          args: engineCheckOnlyArgv(enginePath, res),
          cwd: enginePath,
          userDir,
          timeoutMs: ENGINE_CHECK_TIMEOUT_MS,
          label: `check:${rel}`,
        })
        const out = await handle.done
        if (out.spawnError || out.timedOut || out.signal) {
          result.failures.push({ file: res, exitCode: out.exitCode, signal: out.signal, spawnError: out.spawnError, timedOut: out.timedOut })
          continue
        }
        const reading = readCheckOnlyOutput(out.output, res, result.autoloads)
        for (const d of reading.diagnostics) result.diagnostics.push({ ...d, lastChange: await attribution(d.file) })
        result.ignored.push(...reading.ignored)
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, scripts.length) }, () => runNext()))
    if (shaders.length > 0) {
      const scriptRel = path.posix.join(MERCURY_PROJECT_DIR, ENGINE_DIR_SEGMENT, 'checks', checkId, 'shader_check.gd')
      const scriptFile = path.join(enginePath, ...scriptRel.split('/'))
      mkdirSync(path.dirname(scriptFile), { recursive: true })
      writeFileSync(scriptFile, shaderCheckScript(shaders.map(s => `res://${s}`)))
      const handle = spawnEngine({
        executable: opts.executable,
        args: engineScriptArgv(enginePath, `res://${scriptRel}`),
        cwd: enginePath,
        userDir,
        timeoutMs: ENGINE_CHECK_TIMEOUT_MS,
        label: 'check:shaders',
      })
      const out = await handle.done
      if (out.spawnError || out.timedOut || out.signal) {
        result.failures.push({ file: 'shaders', exitCode: out.exitCode, signal: out.signal, spawnError: out.spawnError, timedOut: out.timedOut })
      } else {
        for (const d of readShaderCheckOutput(out.output)) {
          result.diagnostics.push({ file: d.file, line: d.line, message: d.message, class: 'shader-error', lastChange: await attribution(d.file) })
        }
        if (!stripEngineAnsi(out.output).includes(SHADER_DONE_LINE)) {
          result.failures.push({ file: 'shaders', exitCode: out.exitCode, signal: out.signal, spawnError: 'the shader probe did not reach its end line', timedOut: false })
        }
      }
      if (enginePath === projectRoot) rmSync(path.dirname(scriptFile), { recursive: true, force: true })
    }
    const roots = new Set<string>(scriptSuites)
    for (const rel of scripts) {
      try {
        if (isScriptModeHead(readFileSync(path.join(enginePath, rel), 'utf8'))) roots.add(`res://${rel}`)
      } catch {
        continue
      }
    }
    for (const suiteRes of roots) {
      for (const f of preloadFindings(enginePath, suiteRes, result.autoloads)) {
        const message =
          f.target === f.suite
            ? `the --script suite itself names autoload ${f.autoload} (line ${f.targetLine}); a script-mode run compiles before autoloads exist, so the run fails with "Identifier not found: ${f.autoload}"`
            : `preload chain ${f.chain.join(' → ')} reaches ${f.target}, which names autoload ${f.autoload} (line ${f.targetLine}); a --script suite compiles its preload graph before autoloads exist, so the run fails with "Identifier not found: ${f.autoload}"`
        result.diagnostics.push({ file: f.suite, line: f.line, message, class: 'preload-reaches-autoload', lastChange: await attribution(f.target) })
      }
    }
    const cache = classCacheReport(enginePath, 10)
    if (cache.state !== 'fresh') result.classCache = cache.hint
    result.ok = result.diagnostics.length === 0 && result.failures.length === 0
    return result
  } finally {
    if (treePath) removeEngineTree(treePath)
    rmSync(checkDir, { recursive: true, force: true })
    result.seconds = Math.round((Date.now() - t0) / 100) / 10
  }
}
