import { KV_CACHE_DEFAULT_TYPE, gibWords, kvCacheBytes, tokensWords, type KvGeometry } from './localServerMemory.js'
import type { LocalServerTruth } from './localServerTruth.js'

export const LOCAL_WINDOW_LADDER: readonly number[] = [32_768, 65_536, 131_072, 262_144]

export interface LocalWindowFitInput {
  name: string
  weightsBytes: number
  geometry: KvGeometry
  trainedMax?: number
  machineBytes: number
  usableBytes: number
  usableSource?: string
  slots?: number
  cacheType?: string
}

export interface LocalWindowFitRung {
  window: number
  cacheBytes: number
  totalBytes: number
  fits: boolean
}

export interface LocalWindowFit {
  name: string
  window: number
  fits: boolean
  atMax: boolean
  weightsBytes: number
  cacheBytes: number
  totalBytes: number
  usableBytes: number
  usableSource?: string
  machineBytes: number
  trainedMax?: number
  slots: number
  cacheType: string
  geometry: KvGeometry
  ladder: LocalWindowFitRung[]
  words: string
}

export function localWindowRungs(trainedMax?: number): number[] {
  const rungs = LOCAL_WINDOW_LADDER.filter(window => trainedMax === undefined || window <= trainedMax)
  if (rungs.length === 0 && trainedMax !== undefined) rungs.push(trainedMax)
  return rungs
}

export function localWindowLoad(input: Pick<LocalWindowFitInput, 'weightsBytes' | 'geometry' | 'usableBytes' | 'slots' | 'cacheType'>, window: number): LocalWindowFitRung {
  const cacheBytes = kvCacheBytes(input.geometry, window, Math.max(1, Math.floor(input.slots ?? 1)), input.cacheType)
  const totalBytes = input.weightsBytes + cacheBytes
  return { window, cacheBytes, totalBytes, fits: totalBytes <= input.usableBytes }
}

export function localWindowFitWords(fit: Omit<LocalWindowFit, 'words'>): string {
  const parts = `${gibWords(fit.weightsBytes)} weights + ${gibWords(fit.cacheBytes)} cache`
  const box = `${gibWords(fit.machineBytes)} box`
  const tail = ` · ${fit.cacheType} · ${fit.slots} slot${fit.slots === 1 ? '' : 's'}`
  if (!fit.fits) return `${tokensWords(fit.window)} · ${parts} — ${gibWords(fit.totalBytes)} does not fit in ${gibWords(fit.usableBytes)} usable (${box})${tail}`
  const next = fit.ladder.find(rung => rung.window > fit.window && !rung.fits)
  const refused = !fit.atMax && next !== undefined ? ` · ${tokensWords(next.window)} does not fit (${gibWords(next.totalBytes)})` : ''
  return `${tokensWords(fit.window)} · ${parts} of ${gibWords(fit.usableBytes)} usable (${box})${tail}${refused}`
}

export function fitLocalWindow(input: LocalWindowFitInput): LocalWindowFit {
  const slots = Math.max(1, Math.floor(input.slots ?? 1))
  const cacheType = (input.cacheType ?? KV_CACHE_DEFAULT_TYPE).toLowerCase()
  const project = { weightsBytes: input.weightsBytes, geometry: input.geometry, usableBytes: input.usableBytes, slots, cacheType }
  const ladder = localWindowRungs(input.trainedMax).map(window => localWindowLoad(project, window))
  const fitting = ladder.filter(rung => rung.fits)
  const chosen = fitting.length > 0 ? fitting[fitting.length - 1]! : ladder[0]!
  const fit: Omit<LocalWindowFit, 'words'> = {
    name: input.name,
    window: chosen.window,
    fits: chosen.fits,
    atMax: input.trainedMax !== undefined && chosen.window === input.trainedMax,
    weightsBytes: input.weightsBytes,
    cacheBytes: chosen.cacheBytes,
    totalBytes: chosen.totalBytes,
    usableBytes: input.usableBytes,
    ...(input.usableSource !== undefined ? { usableSource: input.usableSource } : {}),
    machineBytes: input.machineBytes,
    ...(input.trainedMax !== undefined ? { trainedMax: input.trainedMax } : {}),
    slots,
    cacheType,
    geometry: input.geometry,
    ladder,
  }
  return { ...fit, words: localWindowFitWords(fit) }
}

export function localWindowRefusal(fit: LocalWindowFit, window: number): string | undefined {
  const load = localWindowLoad(fit, window)
  if (load.fits) return undefined
  return `${gibWords(load.totalBytes)} does not fit ${gibWords(fit.usableBytes)} usable · ${fit.fits ? `${tokensWords(fit.window)} fits` : 'no rung fits'}`
}

function envNumber(value: string | undefined): number | undefined {
  const n = Number(value)
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : undefined
}

export function serverCacheTypeOf(truth: LocalServerTruth | null): string | undefined {
  return truth?.runners[0]?.cacheTypeK ?? truth?.process?.env['OLLAMA_KV_CACHE_TYPE'] ?? truth?.launchForm.env?.['OLLAMA_KV_CACHE_TYPE']
}

export function serverSlotsOf(truth: LocalServerTruth | null): number {
  return truth?.runners[0]?.slots ?? envNumber(truth?.process?.env['OLLAMA_NUM_PARALLEL']) ?? envNumber(truth?.launchForm.env?.['OLLAMA_NUM_PARALLEL']) ?? 1
}

export function fitLocalWindowOn(truth: LocalServerTruth, model: { name: string; weightsBytes: number; geometry: KvGeometry; trainedMax?: number }, slots: number = serverSlotsOf(truth), cacheType: string | undefined = serverCacheTypeOf(truth)): LocalWindowFit {
  return fitLocalWindow({
    name: model.name,
    weightsBytes: model.weightsBytes,
    geometry: model.geometry,
    ...(model.trainedMax !== undefined ? { trainedMax: model.trainedMax } : {}),
    machineBytes: truth.machine.totalMemoryBytes,
    usableBytes: truth.machine.usableMemoryBytes,
    usableSource: truth.machine.usableSource,
    slots,
    ...(cacheType !== undefined ? { cacheType } : {}),
  })
}
