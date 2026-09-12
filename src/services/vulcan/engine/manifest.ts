import { existsSync, readFileSync } from 'node:fs'
import { MERCURY_PROJECT_DIR } from '../../../utils/projectConfig.js'
import { projectLocalPath } from '../../projectLocal/paths.js'

export const ENGINE_MANIFEST_FILE = 'engine-suites.json'
export const ENGINE_MANIFEST_RELATIVE = `${MERCURY_PROJECT_DIR}/${ENGINE_MANIFEST_FILE}`
export const IMPORT_SUITE_NAME = 'import'
export const RUNNER_DEFAULT_QUIT_AFTER = 15000
export const RUNNER_DEFAULT_SUITE_TIMEOUT_MS = 240000
export const RUNNER_IMPORT_TIMEOUT_MS = 1200000
export const RUNNER_DEFAULT_SUITE_DIR = 'tests'
export const RUNNER_UNCLEAN_SOURCE = 'SCRIPT ERROR|SHADER ERROR|Parse Error|^ERROR:|^FAIL:|leaked|resources still in use'
export const RUNNER_UNCLEAN_FLAGS = 'im'

export type EngineMarker = { kind: 'line'; text: string } | { kind: 'pattern'; source: string; flags: string }

export type EngineUserDirPolicy = 'fresh' | 'keep'

export interface EngineSuite {
  name: string
  marker: EngineMarker
  quitAfter: number
  timeoutMs: number
  script: boolean
  scene: string | null
  nativeOnly: boolean
  userArgs: string[]
  local: boolean
  userDir: EngineUserDirPolicy
}

export interface EngineManifestDefaults {
  quitAfter: number
  timeoutMs: number
  importTimeoutMs: number
  suiteDir: string
}

export interface EngineManifest {
  projectRoot: string
  file: string
  found: boolean
  executable: string | null
  defaults: EngineManifestDefaults
  uncleanSource: string
  uncleanFlags: string
  suites: EngineSuite[]
  problems: string[]
  teaching: string | null
}

export type SuiteSelectionEntry = { kind: 'import' } | { kind: 'suite'; suite: EngineSuite }

export interface SuiteSelection {
  entries: SuiteSelectionEntry[]
  unknown: string[]
}

export function runnerDefaults(): EngineManifestDefaults {
  return {
    quitAfter: RUNNER_DEFAULT_QUIT_AFTER,
    timeoutMs: RUNNER_DEFAULT_SUITE_TIMEOUT_MS,
    importTimeoutMs: RUNNER_IMPORT_TIMEOUT_MS,
    suiteDir: RUNNER_DEFAULT_SUITE_DIR,
  }
}

export function engineManifestPath(projectRoot: string): string {
  return projectLocalPath(projectRoot, ENGINE_MANIFEST_FILE)
}

export function parseEngineMarker(raw: unknown): EngineMarker | null {
  if (typeof raw === 'string') {
    const m = /^\/(.+)\/([a-z]*)$/s.exec(raw)
    if (m) {
      try {
        new RegExp(m[1], m[2])
      } catch {
        return null
      }
      return { kind: 'pattern', source: m[1], flags: m[2] }
    }
    const text = raw.trim()
    return text.length > 0 ? { kind: 'line', text } : null
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { pattern?: unknown; flags?: unknown }
    if (typeof o.pattern === 'string' && o.pattern.length > 0) {
      const flags = typeof o.flags === 'string' ? o.flags : ''
      try {
        new RegExp(o.pattern, flags)
      } catch {
        return null
      }
      return { kind: 'pattern', source: o.pattern, flags }
    }
  }
  return null
}

export function describeMarker(marker: EngineMarker): string {
  return marker.kind === 'line' ? marker.text : `/${marker.source}/${marker.flags}`
}

export function markerLineOf(marker: EngineMarker, output: string): string | null {
  const re = marker.kind === 'pattern' ? new RegExp(marker.source, marker.flags) : null
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (re ? re.test(line) : line === (marker as { text: string }).text) return line
  }
  return null
}

export function uncleanRegExp(source: string = RUNNER_UNCLEAN_SOURCE, flags: string = RUNNER_UNCLEAN_FLAGS): RegExp {
  return new RegExp(source, flags)
}

export function isCleanEngineLog(output: string, unclean: RegExp = uncleanRegExp()): boolean {
  unclean.lastIndex = 0
  return !unclean.test(output)
}

function positiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const SUITE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

export function engineManifestTeaching(projectRoot: string, found: boolean): string {
  const d = runnerDefaults()
  const lead = found
    ? `${ENGINE_MANIFEST_RELATIVE} in ${projectRoot} registers no suites`
    : `no ${ENGINE_MANIFEST_RELATIVE} in ${projectRoot} — the runner's defaults apply (quitAfter ${d.quitAfter}, suite timeout ${d.timeoutMs} ms, import ${d.importTimeoutMs} ms) and no suites are registered`
  return (
    `${lead}. Write it as { "version": 1, "suites": [ { "name": "shield_checks", "marker": "SHIELD PASS" }, ` +
    `{ "name": "castle_checks", "marker": "/^CASTLE PASS: \\\\d+ checks, 0 failures$/", "quitAfter": 120000, "timeoutMs": 720000, "nativeOnly": true }, ` +
    `{ "name": "faran_checks", "marker": "FARANS PASS", "script": true } ] } — a suite is ${d.suiteDir}/<name>.tscn, or --script res://${d.suiteDir}/<name>.gd with "script": true; ` +
    `per suite: "scene" (a path under ${d.suiteDir}/ without .tscn), "userArgs" (passed after --), "local" (skipped when its file is absent), "userDir": "keep" (one user directory per suite instead of an empty one per job); ` +
    `at the top: "defaults" { quitAfter, timeoutMs, importTimeoutMs, suiteDir }, "unclean" (the regular expression for unclean log lines; WARNING: lines never count), "executable" (the Godot binary to run)`
  )
}

export function parseEngineManifest(text: string, projectRoot: string, file: string): EngineManifest {
  const defaults = runnerDefaults()
  const manifest: EngineManifest = {
    projectRoot,
    file,
    found: true,
    executable: null,
    defaults,
    uncleanSource: RUNNER_UNCLEAN_SOURCE,
    uncleanFlags: RUNNER_UNCLEAN_FLAGS,
    suites: [],
    problems: [],
    teaching: null,
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    manifest.problems.push(`${file} is not JSON: ${(e as Error).message}`)
    manifest.teaching = engineManifestTeaching(projectRoot, true)
    return manifest
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    manifest.problems.push(`${file} must be an object { "version": 1, "suites": [...] }`)
    manifest.teaching = engineManifestTeaching(projectRoot, true)
    return manifest
  }
  const doc = parsed as Record<string, unknown>
  if (doc.version !== undefined && doc.version !== 1) manifest.problems.push(`version ${String(doc.version)} is not 1`)
  if (typeof doc.executable === 'string' && doc.executable.trim().length > 0) manifest.executable = doc.executable.trim()
  const d = doc.defaults && typeof doc.defaults === 'object' && !Array.isArray(doc.defaults) ? (doc.defaults as Record<string, unknown>) : {}
  defaults.quitAfter = positiveInt(d.quitAfter, defaults.quitAfter)
  defaults.timeoutMs = positiveInt(d.timeoutMs, defaults.timeoutMs)
  defaults.importTimeoutMs = positiveInt(d.importTimeoutMs, defaults.importTimeoutMs)
  if (typeof d.suiteDir === 'string' && /^[A-Za-z0-9_./-]+$/.test(d.suiteDir)) defaults.suiteDir = d.suiteDir.replace(/\/+$/, '')
  if (typeof doc.unclean === 'string' && doc.unclean.length > 0) {
    try {
      new RegExp(doc.unclean, RUNNER_UNCLEAN_FLAGS)
      manifest.uncleanSource = doc.unclean
    } catch (e) {
      manifest.problems.push(`unclean is not a regular expression: ${(e as Error).message}`)
    }
  }
  const rawSuites = Array.isArray(doc.suites) ? doc.suites : []
  if (doc.suites !== undefined && !Array.isArray(doc.suites)) manifest.problems.push('suites must be an array')
  const seen = new Set<string>()
  rawSuites.forEach((entry, index) => {
    let name = ''
    let obj: Record<string, unknown> = {}
    if (Array.isArray(entry)) {
      name = typeof entry[0] === 'string' ? entry[0] : ''
      obj = { marker: entry[1], ...(entry[2] && typeof entry[2] === 'object' ? (entry[2] as Record<string, unknown>) : {}) }
    } else if (entry && typeof entry === 'object') {
      obj = entry as Record<string, unknown>
      name = typeof obj.name === 'string' ? obj.name : ''
    }
    if (!SUITE_NAME_RE.test(name)) {
      manifest.problems.push(`suites[${index}] has no usable name`)
      return
    }
    if (name === IMPORT_SUITE_NAME) {
      manifest.problems.push(`suites[${index}] "${IMPORT_SUITE_NAME}" is the import pass, not a suite name`)
      return
    }
    if (seen.has(name)) {
      manifest.problems.push(`suite "${name}" is registered twice`)
      return
    }
    const marker = parseEngineMarker(obj.marker)
    if (!marker) {
      manifest.problems.push(`suite "${name}" needs a marker: a whole line, or "/pattern/flags"`)
      return
    }
    const userArgs = Array.isArray(obj.userArgs) ? obj.userArgs.filter((a): a is string => typeof a === 'string' && a.length > 0) : []
    seen.add(name)
    manifest.suites.push({
      name,
      marker,
      quitAfter: positiveInt(obj.quitAfter, defaults.quitAfter),
      timeoutMs: positiveInt(obj.timeoutMs, defaults.timeoutMs),
      script: obj.script === true,
      scene: typeof obj.scene === 'string' && obj.scene.length > 0 ? obj.scene : null,
      nativeOnly: obj.nativeOnly === true,
      userArgs,
      local: obj.local === true,
      userDir: obj.userDir === 'keep' ? 'keep' : 'fresh',
    })
  })
  if (manifest.suites.length === 0) manifest.teaching = engineManifestTeaching(projectRoot, true)
  return manifest
}

export function readEngineManifest(projectRoot: string): EngineManifest {
  const file = engineManifestPath(projectRoot)
  if (!existsSync(file)) {
    return {
      projectRoot,
      file,
      found: false,
      executable: null,
      defaults: runnerDefaults(),
      uncleanSource: RUNNER_UNCLEAN_SOURCE,
      uncleanFlags: RUNNER_UNCLEAN_FLAGS,
      suites: [],
      problems: [],
      teaching: engineManifestTeaching(projectRoot, false),
    }
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    const manifest = parseEngineManifest('{}', projectRoot, file)
    manifest.problems.push(`${file} could not be read: ${(e as Error).message}`)
    return manifest
  }
  return parseEngineManifest(text, projectRoot, file)
}

export function resolveEngineSuites(manifest: EngineManifest, names: readonly string[]): SuiteSelection {
  if (names.length === 0) {
    return { entries: manifest.suites.map(suite => ({ kind: 'suite' as const, suite })), unknown: [] }
  }
  const entries: SuiteSelectionEntry[] = []
  const unknown: string[] = []
  for (const name of names) {
    if (name === IMPORT_SUITE_NAME) {
      entries.push({ kind: 'import' })
      continue
    }
    const suite = manifest.suites.find(s => s.name === name)
    if (suite) entries.push({ kind: 'suite', suite })
    else unknown.push(name)
  }
  return { entries, unknown }
}

export function suiteScenePath(suite: EngineSuite, defaults: EngineManifestDefaults): string {
  return `${defaults.suiteDir}/${suite.scene ?? suite.name}.tscn`
}

export function suiteScriptRes(suite: EngineSuite, defaults: EngineManifestDefaults): string {
  return `res://${defaults.suiteDir}/${suite.name}.gd`
}

export function suiteRelativeFile(suite: EngineSuite, defaults: EngineManifestDefaults): string {
  return suite.script ? `${defaults.suiteDir}/${suite.name}.gd` : suiteScenePath(suite, defaults)
}

export function describeSuite(suite: EngineSuite): string {
  return `${suite.name}: ${describeMarker(suite.marker)}`
}
