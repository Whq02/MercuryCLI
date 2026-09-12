import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { cpus, platform, arch, hostname } from 'node:os'
import { engineManifestPath } from './manifest.js'
import { projectLocalPath } from '../../projectLocal/paths.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { runningGodotProcesses, type GodotProcess } from '../godotProcessCensus.js'

export type EngineMediaKind = 'capture' | 'profile'
export type EngineMediaRoute = 'headless' | 'hidden' | 'display'
export type EngineMediaValue = string | number | boolean | null

export interface EngineTourStep {
  name: string
  frames: number
  camera?: { node: string; position?: number[]; rotation?: number[]; target?: number[]; fov?: number }
  timeOfDay?: number
}

export interface EngineTour {
  scene?: string
  script?: string
  steps: EngineTourStep[]
}

export interface EngineMediaRequest {
  kind: EngineMediaKind
  source: 'auto' | 'engine' | 'project'
  tour: EngineTour
  tourName: string | null
  route: EngineMediaRoute
  clock: { simulationTime: number; shaderTime: number; seed: number; fps: number }
  pair: { switch: string; a: EngineMediaValue; b: EngineMediaValue } | null
  settleFrames: number
  sampleFrames: number
  quiet: 'refuse' | 'flag'
  baseline: { save: boolean; compare: string | null }
}

export interface EngineMediaFrame {
  path: string
  variant: string
  stepIndex: number
  step: EngineTourStep
  frameIndex: number
}

export interface EngineMediaStats {
  samples: number
  median: number
  p95: number
}

export interface EngineMediaPhase {
  variant: string
  stepIndex: number
  step: EngineTourStep
  frameMs: EngineMediaStats
  processMs: EngineMediaStats
  physicsMs: EngineMediaStats
  navigationMs: EngineMediaStats | null
  gpuMs: EngineMediaStats | null
  renderCpuMs: EngineMediaStats | null
  scripts: Array<{ script: string; selfMs: EngineMediaStats; totalMs: EngineMediaStats; calls: EngineMediaStats }>
  physics: Record<string, EngineMediaStats>
}

export interface EngineMediaRecord {
  kind: EngineMediaKind
  request: EngineMediaRequest
  tourHash: string
  route: EngineMediaRoute
  displayRequested: boolean
  boots: number
  frames: EngineMediaFrame[]
  contactSheet: { path: string; width: number; height: number; frames: Array<{ path: string; index: number; x: number; y: number; width: number; height: number }> } | null
  phases: EngineMediaPhase[]
  selectedSource?: 'engine' | 'project'
  sources?: string[]
  fallbackReason?: string | null
  evidence: Array<Record<string, unknown>>
  limitations: string[]
  quiet: { policy: 'refuse' | 'flag'; contaminated: boolean; observations: Array<{ at: string; stage: string; workers: string[] }> }
  baseline: { saved: string | null; compared: string | null; comparable: boolean; reason: string | null; metrics: Array<{ metric: string; baseline: number; current: number; delta: number; percent: number | null }> }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function finite(value: unknown, fallback: number, name: string, min = 0, max = 1_000_000): number {
  const n = value === undefined ? fallback : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} through ${max}`)
  return n
}

function integer(value: unknown, fallback: number, name: string, min = 0, max = 10_000): number {
  const n = finite(value, fallback, name, min, max)
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`)
  return n
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`${name} must be a nonempty string of at most 512 characters`)
  return value
}

function resource(value: unknown, name: string, suffix: string): string {
  const s = text(value, name).replace(/^res:\/\//, '')
  if (s.includes('\\') || s.startsWith('/') || s.includes(':') || s.split('/').some(p => p === '..' || p === '.' || !p) || !s.endsWith(suffix)) throw new Error(`${name} must be a project resource ending in ${suffix}, without parent traversal`)
  return `res://${s}`
}

function vector(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error(`${name} must be [x,y,z] with finite numbers`)
  return [...value] as number[]
}

function mediaValue(value: unknown, name: string): EngineMediaValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value
  throw new Error(`${name} must be a JSON scalar (boolean, number, string, or null)`)
}

export function parseEngineMediaRequest(kind: EngineMediaKind, args: Record<string, unknown>, projectRoot: string): EngineMediaRequest {
  let rawTour = args.tour
  let tourName: string | null = null
  if (typeof rawTour === 'string') {
    tourName = rawTour
    const file = engineManifestPath(projectRoot)
    let manifest: Record<string, unknown>
    try {
      manifest = object(JSON.parse(readFileSync(file, 'utf8')), file)
    } catch (e) {
      throw new Error(`named tour ${JSON.stringify(tourName)} needs a tours map in ${file}: ${(e as Error).message}`)
    }
    const tours = object(manifest.tours, `${file} tours`)
    if (!Object.hasOwn(tours, tourName)) throw new Error(`unknown tour ${JSON.stringify(tourName)}; registered tours: ${Object.keys(tours).join(', ') || 'none'}`)
    rawTour = tours[tourName]
  }
  const input = object(rawTour, 'tour (a registered name or {scene|script,steps})')
  if ((input.scene !== undefined) === (input.script !== undefined)) throw new Error('tour needs exactly one scene (.tscn) or script (.gd extending Node)')
  const tour: EngineTour = { steps: [] }
  if (input.scene !== undefined) tour.scene = resource(input.scene, 'tour.scene', '.tscn')
  if (input.script !== undefined) tour.script = resource(input.script, 'tour.script', '.gd')
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 64) throw new Error('tour.steps needs 1 through 64 steps')
  const names = new Set<string>()
  tour.steps = input.steps.map((raw, i) => {
    const s = object(raw, `tour.steps[${i}]`)
    const name = text(s.name, `tour.steps[${i}].name`)
    if (names.has(name)) throw new Error(`tour step ${JSON.stringify(name)} is repeated`)
    names.add(name)
    const step: EngineTourStep = { name, frames: integer(s.frames, 1, 'step.frames', 1, 32) }
    if (s.timeOfDay !== undefined) step.timeOfDay = finite(s.timeOfDay, 12, 'step.timeOfDay', 0, 24)
    if (s.camera !== undefined) {
      const c = object(s.camera, 'step.camera')
      step.camera = { node: text(c.node, 'step.camera.node') }
      if (c.position !== undefined) step.camera.position = vector(c.position, 'camera.position')
      if (c.rotation !== undefined) step.camera.rotation = vector(c.rotation, 'camera.rotation')
      if (c.target !== undefined) step.camera.target = vector(c.target, 'camera.target')
      if (c.fov !== undefined) step.camera.fov = finite(c.fov, 70, 'camera.fov', 1, 179)
    }
    return step
  })
  if (args.display !== undefined && typeof args.display !== 'boolean') throw new Error('display must be boolean; only true authorizes a visible window')
  if (args.display === true && args.route !== undefined && args.route !== 'display') throw new Error('display:true conflicts with a non-display route')
  const route = args.route ?? (args.display === true ? 'display' : 'headless')
  if (route !== 'headless' && route !== 'hidden' && route !== 'display') throw new Error('route must be headless, hidden, or display; only display authorizes a visible window')
  const clock = args.clock === undefined ? {} : object(args.clock, 'clock')
  let pair: EngineMediaRequest['pair'] = null
  if (args.pair !== undefined && args.pair !== null) {
    const p = object(args.pair, 'pair')
    pair = { switch: text(p.switch, 'pair.switch'), a: mediaValue(p.a, 'pair.a'), b: mediaValue(p.b, 'pair.b') }
    if (Object.is(pair.a, pair.b)) throw new Error('pair.a and pair.b must differ: a pair flips exactly one named switch')
  }
  if (kind === 'capture' && tour.steps.reduce((count, step) => count + step.frames, 0) * (pair ? 2 : 1) > 64) throw new Error('capture needs at most 64 total frames, including both pair variants, so every frame fits the contact sheet')
  const baseline = args.baseline === undefined ? {} : object(args.baseline, 'baseline')
  if (baseline.save !== undefined && typeof baseline.save !== 'boolean') throw new Error('baseline.save must be boolean')
  const compare = baseline.compare === undefined || baseline.compare === null ? null : text(baseline.compare, 'baseline.compare')
  if (compare !== null && !/^[0-9a-f]{40,64}$/.test(compare)) throw new Error('baseline.compare must be a full commit SHA from an earlier profile record')
  const source = args.source ?? 'auto'
  if (source !== 'auto' && source !== 'engine' && source !== 'project') throw new Error('source must be engine, project, or auto')
  if (kind !== 'profile' && args.source !== undefined) throw new Error('source is only supported by profile jobs')
  const quiet = args.quiet ?? 'refuse'
  if (quiet !== 'refuse' && quiet !== 'flag') throw new Error('quiet must be refuse or flag; other engine workers cannot be ignored')
  return {
    kind, source, tour, tourName, route,
    clock: {
      simulationTime: finite(clock.simulationTime, 0, 'clock.simulationTime'),
      shaderTime: finite(clock.shaderTime, 0, 'clock.shaderTime'),
      seed: integer(clock.seed, 1, 'clock.seed', 0, 2_147_483_647),
      fps: integer(clock.fps, 60, 'clock.fps', 1, 240),
    },
    pair,
    settleFrames: integer(args.settleFrames, 60, 'settleFrames', 1, 10_000),
    sampleFrames: integer(args.sampleFrames, 120, 'sampleFrames', 2, 10_000),
    quiet,
    baseline: { save: baseline.save === true, compare },
  }
}

export function newEngineMediaRecord(request: EngineMediaRequest): EngineMediaRecord {
  return {
    kind: request.kind, request, tourHash: createHash('sha256').update(JSON.stringify(request.tour)).digest('hex'), route: request.route,
    displayRequested: request.route === 'display', boots: 0, frames: [], contactSheet: null, phases: [], evidence: [],
    limitations: [
      'Headless uses Godot dummy rendering: images come from the project Image hook, not a rendered viewport.',
      'Godot global RNG is seeded; independently created RNGs, external randomness, wall clocks, autoload initialization, and shader TIME require project hook cooperation. No universal freeze is claimed.',
      'Capture simulation is paused with Engine.time_scale=0; the project hook applies the requested simulation time and deterministic shader uniforms. Built-in shader TIME has no exposed setter.',
      'Project script and physics tables are instrumentation. The separately labelled engine debugger source carries Godot 4.6 profiler tables when connected; the selected source is named.',
      'The quiet guard samples the process census and live worker registry; short-lived workers between observations can escape detection.',
      'Hidden routing is refused on stock Godot: its native bootstrap shows the main window before scripts can hide it.',
    ],
    quiet: { policy: request.quiet, contaminated: false, observations: [] },
    baseline: { saved: null, compared: null, comparable: false, reason: null, metrics: [] },
  }
}

export function engineMediaStats(values: unknown, name: string, expected?: number): EngineMediaStats {
  if (!Array.isArray(values) || values.length === 0 || (expected !== undefined && values.length !== expected) || values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error(`${name} must contain ${expected ?? 'one or more'} finite nonnegative timing samples`)
  const sorted = [...values].sort((a, b) => a - b) as number[]
  const mid = Math.floor(sorted.length / 2)
  return { samples: sorted.length, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}

export function readEngineMediaBoot(file: string, request: EngineMediaRequest, variant: string, outputDir: string): { evidence: Record<string, unknown>; frames: EngineMediaFrame[]; phases: EngineMediaPhase[] } {
  const doc = object(JSON.parse(readFileSync(file, 'utf8')), 'media driver result')
  const evidence = object(doc.evidence, 'media driver evidence')
  if (doc.kind !== request.kind) throw new Error('media driver returned the wrong job kind')
  if (request.kind === 'capture' && (evidence.simulationClock !== true || evidence.shaderClock !== true || evidence.seeded !== true || typeof evidence.notes !== 'string' || !evidence.notes.trim())) throw new Error('capture needs project clock cooperation evidence: simulationClock, shaderClock, seeded, and notes')
  const frames: EngineMediaFrame[] = []
  if (request.kind === 'capture') {
    if (!Array.isArray(doc.frames)) throw new Error('capture driver returned no frame list')
    let index = 0
    for (const [stepIndex, step] of request.tour.steps.entries()) {
      for (let frameIndex = 0; frameIndex < step.frames; frameIndex++) {
        const f = object(doc.frames[index++], 'capture frame')
        const expected = path.join(outputDir, `${stepIndex}-${frameIndex}.png`)
        if (f.variant !== variant || f.stepIndex !== stepIndex || f.frameIndex !== frameIndex || path.resolve(String(f.path)) !== expected || !existsSync(expected)) throw new Error('capture frame paths, variants, or tour steps do not match the frozen request')
        frames.push({ path: expected, variant, stepIndex, step, frameIndex })
      }
    }
    if (doc.frames.length !== index) throw new Error('capture driver returned unexpected extra frames')
  }
  const phases: EngineMediaPhase[] = []
  if (request.kind === 'profile') {
    const variants = request.pair ? ['a', 'b'] : ['single']
    if (!Array.isArray(doc.phases) || doc.phases.length !== request.tour.steps.length * variants.length) throw new Error('profile driver returned incomplete phases')
    let index = 0
    for (const v of variants) {
      for (const [stepIndex, step] of request.tour.steps.entries()) {
        const p = object(doc.phases[index++], 'profile phase')
        if (p.variant !== v || p.stepIndex !== stepIndex) throw new Error('profile phase does not match its tour step and variant')
        const n = request.sampleFrames
        const physics = object(p.physics, 'physics component samples')
        const components: Record<string, EngineMediaStats> = {}
        for (const [key, value] of Object.entries(physics)) components[key] = engineMediaStats(value, `physics.${key}`, n)
        if (!Array.isArray(p.scripts) || (evidence.projectTables !== false && (p.scripts.length === 0 || Object.keys(components).length === 0))) throw new Error('profile needs at least one instrumented script row and one physics component; empty tables do not establish decomposition')
        if (evidence.projectTables === false && (evidence.debuggerConnected !== true || p.scripts.length || Object.keys(components).length)) throw new Error('uninstrumented profile requires engine debugger evidence and no project tables')
        phases.push({
          variant: v, stepIndex, step,
          frameMs: engineMediaStats(p.frameMs, 'frameMs', n), processMs: engineMediaStats(p.processMs, 'processMs', n),
          physicsMs: engineMediaStats(p.physicsMs, 'physicsMs', n), navigationMs: engineMediaStats(p.navigationMs, 'navigationMs', n),
          gpuMs: Array.isArray(p.gpuMs) && p.gpuMs.length ? engineMediaStats(p.gpuMs, 'gpuMs') : null,
          renderCpuMs: Array.isArray(p.renderCpuMs) && p.renderCpuMs.length ? engineMediaStats(p.renderCpuMs, 'renderCpuMs') : null,
          scripts: p.scripts.map(raw => {
            const s = object(raw, 'script sample')
            return { script: text(s.script, 'script'), selfMs: engineMediaStats(s.selfMs, 'script.selfMs', n), totalMs: engineMediaStats(s.totalMs, 'script.totalMs', n), calls: engineMediaStats(s.calls, 'script.calls', n) }
          }), physics: components,
        })
      }
    }
  }
  return { evidence, frames, phases }
}

function metrics(record: EngineMediaRecord): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of record.phases) {
    const prefix = `${p.variant}/${p.stepIndex}`
    const stats: Record<string, EngineMediaStats | null> = { frameMs: p.frameMs, processMs: p.processMs, physicsMs: p.physicsMs, navigationMs: p.navigationMs, gpuMs: p.gpuMs, renderCpuMs: p.renderCpuMs }
    for (const [key, stat] of Object.entries(p.physics)) stats[`physics/${key}`] = stat
    for (const script of p.scripts) {
      stats[`scripts/${script.script}/selfMs`] = script.selfMs
      stats[`scripts/${script.script}/totalMs`] = script.totalMs
      stats[`scripts/${script.script}/calls`] = script.calls
    }
    for (const [key, stat] of Object.entries(stats)) if (stat) {
      out[`${prefix}/${key}/median`] = stat.median
      out[`${prefix}/${key}/p95`] = stat.p95
    }
  }
  return out
}

export function finishEngineProfileBaseline(projectRoot: string, commit: string, treeDirty: boolean, executable: string, record: EngineMediaRecord): void {
  const request = record.request
  const signature = createHash('sha256').update(JSON.stringify({ version: 2, source: record.selectedSource, tour: request.tour, route: request.route, clock: request.clock, pair: request.pair, settleFrames: request.settleFrames, sampleFrames: request.sampleFrames, executable, engine: record.evidence.map(e => ({ version: e.engine, renderer: e.renderer })), platform: platform(), arch: arch(), machine: hostname(), cpus: cpus().map(c => c.model) })).digest('hex')
  const directory = projectLocalPath(projectRoot, 'engine-baselines')
  const current = metrics(record)
  if (request.baseline.compare) {
    const file = path.join(directory, `${request.baseline.compare}.json`)
    record.baseline.compared = file
    try {
      const stored = object(JSON.parse(readFileSync(file, 'utf8')), 'baseline')
      const old = object(stored.metrics, 'baseline metrics')
      const sameKeys = Object.keys(old).sort().join('\0') === Object.keys(current).sort().join('\0')
      if (stored.signature !== signature || !sameKeys || stored.contaminated !== false || record.quiet.contaminated) record.baseline.reason = 'Baseline and current run differ in tour, machine, engine, measurement settings, available metrics, or quiet evidence; no speed comparison is claimed.'
      else {
        record.baseline.comparable = true
        record.baseline.metrics = Object.entries(current).map(([metric, value]) => {
          const before = old[metric]
          if (typeof before !== 'number' || !Number.isFinite(before)) throw new Error(`baseline metric ${metric} is not finite`)
          return { metric, baseline: before, current: value, delta: value - before, percent: before === 0 ? null : (value - before) / before * 100 }
        })
      }
    } catch (e) {
      record.baseline.comparable = false
      record.baseline.metrics = []
      record.baseline.reason = `Cannot compare baseline: ${(e as Error).message}`
    }
  }
  if (request.baseline.save) {
    if (treeDirty || record.quiet.contaminated) {
      record.baseline.reason = 'A per-commit baseline is not saved from an overlaid tree or a contaminated measurement.'
      return
    }
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${commit}.json`)
    try {
      writeFileSync(file, JSON.stringify({ version: 1, commit, signature, contaminated: false, metrics: current, evidence: record.evidence }, null, 2), { flag: 'wx' })
      record.baseline.saved = file
    } catch (e) {
      record.baseline.reason = `Baseline was not replaced: ${(e as Error).message}`
    }
  }
}
export async function engineMediaCensus(): Promise<GodotProcess[]> {
  let failure: string | null = null
  const processes = await runningGodotProcesses({
    runner: {
      async exec(file, args) {
        try {
          const out = await execFileNoThrow(file, args, { useCwd: false, timeout: 8_000 })
          if (out.code !== 0) failure = `${file} exited ${out.code}`
          return { code: out.code, stdout: out.stdout }
        } catch (e) {
          failure = (e as Error).message
          return { code: 1, stdout: '' }
        }
      },
    },
  })
  if (failure !== null) throw new Error(`engine process census unavailable: ${failure}`)
  return processes
}
