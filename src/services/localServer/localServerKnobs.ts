import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { gibWords, kvCacheBytes, projectLoad, tokensWords, type KvGeometry } from './localServerMemory.js'
import type { LocalServerTruth } from './localServerTruth.js'
import { fitLocalWindow, serverCacheTypeOf, serverSlotsOf } from './localWindowFit.js'

export type LocalServerKnobId = 'maxLoadedModels' | 'parallelSlots' | 'keepAlive' | 'contextLength'

export interface LocalServerKnob {
  id: LocalServerKnobId
  envName: string
  label: string
  documentedDefault: string
  kind: 'count' | 'duration' | 'tokens'
}

export const LOCAL_SERVER_KNOBS: readonly LocalServerKnob[] = [
  { id: 'maxLoadedModels', envName: 'OLLAMA_MAX_LOADED_MODELS', label: 'Loaded models at once', documentedDefault: '3 per GPU (3 on CPU)', kind: 'count' },
  { id: 'parallelSlots', envName: 'OLLAMA_NUM_PARALLEL', label: 'Parallel requests per model', documentedDefault: '1', kind: 'count' },
  { id: 'keepAlive', envName: 'OLLAMA_KEEP_ALIVE', label: 'Keep an idle model loaded', documentedDefault: '5m', kind: 'duration' },
  { id: 'contextLength', envName: 'OLLAMA_CONTEXT_LENGTH', label: 'Default context length', documentedDefault: '4096', kind: 'tokens' },
]

export const LOCAL_SERVER_KNOB_DOCS = 'docs.ollama.com/faq'

export const MAX_LOADED_MODELS_LADDER: readonly number[] = [1, 2, 3, 4, 5, 6, 8]
export const PARALLEL_SLOTS_LADDER: readonly number[] = [1, 2, 3, 4, 6, 8]
export const KEEP_ALIVE_LADDER: readonly string[] = ['5m', '10m', '30m', '1h', '4h', '24h', '-1']
export const CONTEXT_LENGTH_LADDER: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

export const KEEP_ALIVE_PATTERN = /^(-?\d+|-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/

export interface LocalServerSettings {
  maxLoadedModels?: number
  parallelSlots?: number
  keepAlive?: string
  contextLength?: number
}

export function localServerSettingsOf(merged: SettingsJson | undefined): LocalServerSettings {
  const raw = merged?.local?.server
  if (!raw || typeof raw !== 'object') return {}
  const out: LocalServerSettings = {}
  if (typeof raw.maxLoadedModels === 'number' && Number.isInteger(raw.maxLoadedModels) && raw.maxLoadedModels >= 1) out.maxLoadedModels = raw.maxLoadedModels
  if (typeof raw.parallelSlots === 'number' && Number.isInteger(raw.parallelSlots) && raw.parallelSlots >= 1) out.parallelSlots = raw.parallelSlots
  if (typeof raw.keepAlive === 'string' && KEEP_ALIVE_PATTERN.test(raw.keepAlive.trim())) out.keepAlive = raw.keepAlive.trim()
  if (typeof raw.contextLength === 'number' && Number.isInteger(raw.contextLength) && raw.contextLength >= 512) out.contextLength = raw.contextLength
  return out
}

export function readLocalServerSettings(): LocalServerSettings {
  return localServerSettingsOf(getInitialSettings() as SettingsJson)
}

export function writeLocalServerSetting(id: LocalServerKnobId, value: number | string | undefined): { error: Error | null } {
  return updateSettingsForSource('userSettings', { local: { server: { [id]: value } } } as Partial<SettingsJson>)
}

export function localServerRevertPartial(snapshot: LocalServerSettings | undefined): Partial<SettingsJson> {
  if (snapshot === undefined || Object.keys(snapshot).length === 0) return { local: { server: undefined } } as Partial<SettingsJson>
  return { local: { server: { maxLoadedModels: snapshot.maxLoadedModels, parallelSlots: snapshot.parallelSlots, keepAlive: snapshot.keepAlive, contextLength: snapshot.contextLength } } } as Partial<SettingsJson>
}

export function knobEnvValue(id: LocalServerKnobId, value: number | string): string {
  return String(value)
}

export function settingsAsEnv(settings: LocalServerSettings): Record<string, string> {
  const env: Record<string, string> = {}
  for (const knob of LOCAL_SERVER_KNOBS) {
    const value = settings[knob.id]
    if (value !== undefined) env[knob.envName] = knobEnvValue(knob.id, value)
  }
  return env
}

export type KeepAlive = { kind: 'seconds'; seconds: number } | { kind: 'forever' } | { kind: 'unload' }

const UNITS: Record<string, number> = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 }

export function parseKeepAlive(text: string | undefined): KeepAlive | undefined {
  const raw = (text ?? '').trim()
  if (!KEEP_ALIVE_PATTERN.test(raw)) return undefined
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw)
    if (n < 0) return { kind: 'forever' }
    if (n === 0) return { kind: 'unload' }
    return { kind: 'seconds', seconds: n }
  }
  const negative = raw.startsWith('-')
  let seconds = 0
  for (const part of raw.replace(/^-/, '').matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) seconds += Number(part[1]) * (UNITS[part[2] ?? 's'] ?? 1)
  if (negative) return { kind: 'forever' }
  if (seconds === 0) return { kind: 'unload' }
  return { kind: 'seconds', seconds }
}

export function keepAliveWords(text: string | undefined): string {
  const parsed = parseKeepAlive(text)
  if (!parsed) return text === undefined ? 'unset' : `${text} (not a duration)`
  if (parsed.kind === 'forever') return `${text} · never unloads`
  if (parsed.kind === 'unload') return `${text} · unloads after each reply`
  const s = parsed.seconds
  if (s % 3600 === 0) return `${s / 3600} h idle`
  if (s % 60 === 0) return `${s / 60} min idle`
  return `${s} s idle`
}

export function nextOnLadder<T extends string | number>(ladder: readonly T[], current: T | undefined, direction: 1 | -1): T {
  if (current === undefined) return direction === 1 ? ladder[0]! : ladder[ladder.length - 1]!
  const at = ladder.indexOf(current)
  if (at >= 0) return ladder[Math.max(0, Math.min(ladder.length - 1, at + direction))]!
  if (typeof current === 'number') {
    const numbers = ladder as readonly number[]
    if (direction === 1) return (numbers.find(rung => rung > current) ?? numbers[numbers.length - 1]!) as T
    for (let i = numbers.length - 1; i >= 0; i--) if (numbers[i]! < current) return numbers[i] as T
    return numbers[0] as T
  }
  return direction === 1 ? ladder[0]! : ladder[ladder.length - 1]!
}

export interface KnobReading {
  id: LocalServerKnobId
  envName: string
  label: string
  setting?: number | string
  running?: string
  file?: string
  documentedDefault: string
  runnerFact?: string
}

export function knobReadings(truth: LocalServerTruth | null, settings: LocalServerSettings): KnobReading[] {
  const runner = truth?.runners[0]
  return LOCAL_SERVER_KNOBS.map(knob => {
    const running = truth?.process?.env[knob.envName]
    const file = truth?.launchForm.env?.[knob.envName]
    const runnerFact =
      knob.id === 'parallelSlots' && runner?.slots !== undefined
        ? `${runner.slots} slot${runner.slots === 1 ? '' : 's'} on the runner`
        : knob.id === 'contextLength' && runner?.context !== undefined
          ? `${tokensWords(runner.context)} on the runner`
          : undefined
    return {
      id: knob.id,
      envName: knob.envName,
      label: knob.label,
      ...(settings[knob.id] !== undefined ? { setting: settings[knob.id]! } : {}),
      ...(running !== undefined ? { running } : {}),
      ...(file !== undefined ? { file } : {}),
      documentedDefault: knob.documentedDefault,
      ...(runnerFact ? { runnerFact } : {}),
    }
  })
}

export function knobValueWords(reading: KnobReading, envReadable: boolean): string {
  const shown = reading.id === 'keepAlive' ? (v: string | number | undefined) => (v === undefined ? undefined : keepAliveWords(String(v))) : (v: string | number | undefined) => (v === undefined ? undefined : reading.id === 'contextLength' ? tokensWords(Number(v)) : String(v))
  const setting = shown(reading.setting)
  const running = shown(reading.running)
  if (setting !== undefined) {
    if (running === undefined) return envReadable ? `${setting} · server: unset (${reading.documentedDefault}) · apply to take effect` : `${setting} · apply to take effect`
    return reading.setting !== undefined && String(reading.setting) === reading.running ? `${setting} · running` : `${setting} · running ${running} · apply to take effect`
  }
  if (running !== undefined) return `${running} · running${reading.runnerFact ? ` · ${reading.runnerFact}` : ''}`
  if (envReadable) return `unset · server default ${reading.documentedDefault}${reading.runnerFact ? ` · ${reading.runnerFact}` : ''}`
  return `unset · documented default ${reading.documentedDefault}`
}

export interface MemoryFacts {
  machineBytes: number
  usableBytes: number
  usableSource: string
  cacheType?: string
  models: Array<{ name: string; weightsBytes: number; geometry: KvGeometry; trainedMax?: number; loadedBytes?: number; loadedWindow?: number; loadedSlots?: number }>
}

export function memoryFactsOf(truth: LocalServerTruth | null): MemoryFacts {
  const cacheType = serverCacheTypeOf(truth)
  const models: MemoryFacts['models'] = []
  for (const model of truth?.listed ?? []) {
    if (!model.geometry || model.sizeBytes === undefined) continue
    const loaded = truth?.loaded.find(l => l.name === model.name)
    models.push({
      name: model.name,
      weightsBytes: model.sizeBytes,
      geometry: model.geometry,
      ...(model.trainedContext !== undefined ? { trainedMax: model.trainedContext } : {}),
      ...(loaded?.sizeBytes !== undefined ? { loadedBytes: loaded.sizeBytes } : {}),
      ...(loaded?.contextLength !== undefined ? { loadedWindow: loaded.contextLength } : {}),
      ...(loaded !== undefined ? { loadedSlots: serverSlotsOf(truth) } : {}),
    })
  }
  return { machineBytes: truth?.machine.totalMemoryBytes ?? 0, usableBytes: truth?.machine.usableMemoryBytes ?? truth?.machine.totalMemoryBytes ?? 0, usableSource: truth?.machine.usableSource ?? 'total memory', ...(cacheType ? { cacheType } : {}), models }
}

export interface ChosenKnobs {
  window: number
  slots: number
  maxLoaded: number
}

function envNumber(truth: LocalServerTruth | null, name: string): number | undefined {
  const n = Number(truth?.process?.env[name])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function chosenKnobs(truth: LocalServerTruth | null, settings: LocalServerSettings): ChosenKnobs {
  const runner = truth?.runners[0]
  return {
    window: settings.contextLength ?? runner?.context ?? envNumber(truth, 'OLLAMA_CONTEXT_LENGTH') ?? truth?.loaded[0]?.contextLength ?? 4096,
    slots: settings.parallelSlots ?? runner?.slots ?? envNumber(truth, 'OLLAMA_NUM_PARALLEL') ?? 1,
    maxLoaded: settings.maxLoadedModels ?? envNumber(truth, 'OLLAMA_MAX_LOADED_MODELS') ?? 1,
  }
}

export interface FitVerdict {
  fits: boolean
  projectedBytes: number
  usableBytes: number
  models: Array<{ name: string; bytes: number }>
  short: string
  words: string
}

export const FIT_REMEDY = 'lower the window or the count'

export function fitVerdict(facts: MemoryFacts, chosen: ChosenKnobs): FitVerdict {
  const count = Math.max(1, chosen.maxLoaded)
  const models = [...facts.models]
    .sort((a, b) => b.weightsBytes - a.weightsBytes)
    .slice(0, count)
    .map(model => ({ name: model.name, bytes: projectLoad(model, chosen.window, chosen.slots, facts.cacheType).totalBytes }))
  const projectedBytes = models.reduce((sum, model) => sum + model.bytes, 0)
  const usableBytes = facts.usableBytes
  const fits = usableBytes <= 0 || models.length === 0 || projectedBytes <= usableBytes
  const named = models.length === 0 ? '' : models.length === 1 ? ` with ${models[0]!.name} loaded` : ` with ${models.map(model => model.name).join(' and ')} loaded`
  const figures = `${gibWords(projectedBytes).replace(' GiB', '')} of ${gibWords(usableBytes)} usable`
  const short = models.length === 0 ? 'nothing to project' : fits ? `fits · ${figures}` : `does not fit · ${figures}`
  const words = models.length === 0 ? 'no model geometry read — nothing to project' : fits ? `${short}${named}` : `${short}${named} — ${FIT_REMEDY}`
  return { fits, projectedBytes, usableBytes, models, short, words }
}

export function knobDetailWords(id: LocalServerKnobId, facts: MemoryFacts, chosen: ChosenKnobs): string {
  const machine = `${gibWords(facts.machineBytes)}, ${gibWords(facts.usableBytes)} usable for models (${facts.usableSource})`
  const usable = gibWords(facts.usableBytes)
  const largest = [...facts.models].sort((a, b) => b.weightsBytes - a.weightsBytes)[0]
  if (id === 'maxLoadedModels') {
    const loads = facts.models.map(model => {
      const window = model.loadedWindow ?? chosen.window
      const projected = projectLoad(model, window, chosen.slots, facts.cacheType)
      const bytes = model.loadedBytes ?? projected.totalBytes
      return { name: model.name, bytes, words: `${model.name} ${gibWords(bytes)} at ${tokensWords(window)}${model.loadedBytes !== undefined ? '' : ' (projected)'}` }
    })
    const total = loads.reduce((sum, load) => sum + load.bytes, 0)
    const together = loads.length > 1 ? ` · all ${loads.length} together ${gibWords(total)} — ${total <= facts.usableBytes ? `fit in ${usable}` : `do not fit in ${usable}`}` : ''
    return `how many models stay loaded before one is evicted; the box has ${machine}: ${loads.length ? loads.map(load => load.words).join(', ') : 'no model sizes read'}${together} · one loaded copy serves many sessions: seven sub-agents on one model need one copy and seven slots, not seven copies · ←/→ move it`
  }
  if (id === 'parallelSlots') {
    if (!largest) return `how many requests one loaded model answers at once; each slot holds its own window of cache · one slot for a single session; 2–4 slots with a 32k window for a crew · ←/→ move it`
    const at = (window: number): string => gibWords(kvCacheBytes(largest.geometry, window, 1, facts.cacheType))
    const fleet = projectLoad(largest, 32768, chosen.slots, facts.cacheType)
    return `how many requests one loaded model answers at once; each slot holds a full window of cache (${largest.name}: ${at(chosen.window)} per slot at ${tokensWords(chosen.window)}, ${at(32768)} at 32k) · one slot for a single session; 2–4 slots with a 32k window for a crew — ${chosen.slots} slot${chosen.slots === 1 ? '' : 's'} at 32k load ${largest.name} as ${gibWords(fleet.totalBytes)} of ${usable} usable · ←/→ move it`
  }
  if (id === 'keepAlive') {
    return `how long an idle model stays loaded before it unloads; a reload ingests the session's prompt again from scratch · -1 keeps it loaded, 0 unloads after every reply, a request's own keep_alive outranks it · ←/→ move it`
  }
  const fits = facts.models.map(model => {
    const projected = projectLoad(model, chosen.window, chosen.slots, facts.cacheType)
    return `${model.name} ${gibWords(projected.totalBytes)}`
  })
  const biggest = facts.models.map(model => {
    const measured = model.loadedBytes !== undefined && model.loadedWindow !== undefined ? { bytes: model.loadedBytes, window: model.loadedWindow, ...(model.loadedSlots !== undefined ? { slots: model.loadedSlots } : {}) } : undefined
    return `${model.name} ${tokensWords(fitLocalWindow({ ...model, machineBytes: facts.machineBytes, usableBytes: facts.usableBytes, slots: chosen.slots, ...(facts.cacheType !== undefined ? { cacheType: facts.cacheType } : {}), ...(measured !== undefined ? { measured } : {}) }).window)}`
  })
  return `the window a request gets when it names none; a bigger window costs cache per slot · at ${tokensWords(chosen.window)} with ${chosen.slots} slot${chosen.slots === 1 ? '' : 's'}: ${fits.length ? fits.join(', ') : 'no model geometry read'} (before the runner's buffers) of ${usable} usable${biggest.length ? ` · the biggest window that fits each alone (auto's rule): ${biggest.join(', ')}` : ''} · a model's own window setting outranks this · ←/→ move it`
}
