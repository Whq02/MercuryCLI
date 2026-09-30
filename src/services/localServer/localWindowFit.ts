import { KV_CACHE_DEFAULT_TYPE, gibWords, kvCacheBytes, tokensWords, type KvGeometry } from './localServerMemory.js'
import type { LocalServerTruth } from './localServerTruth.js'

export const LOCAL_WINDOW_LADDER: readonly number[] = [32_768, 65_536, 131_072, 262_144]

export interface LocalWindowMeasured {
  bytes: number
  window: number
  slots?: number
}

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
  measured?: LocalWindowMeasured
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
  measured?: LocalWindowMeasured
  ladder: LocalWindowFitRung[]
  words: string
}

export function localWindowRungs(trainedMax?: number): number[] {
  const rungs = LOCAL_WINDOW_LADDER.filter(window => trainedMax === undefined || window <= trainedMax)
  if (rungs.length === 0 && trainedMax !== undefined) rungs.push(trainedMax)
  return rungs
}

export type LocalWindowLoadInput = Pick<LocalWindowFitInput, 'weightsBytes' | 'geometry' | 'usableBytes' | 'slots' | 'cacheType' | 'measured'>

export function localWindowResident(input: LocalWindowLoadInput): { bytes: number; measured: LocalWindowMeasured | undefined } {
  const measured = input.measured
  if (measured === undefined) return { bytes: input.weightsBytes, measured: undefined }
  const slots = Math.max(1, Math.floor(measured.slots ?? input.slots ?? 1))
  const cacheAt = kvCacheBytes(input.geometry, measured.window, slots, input.cacheType)
  if (measured.bytes <= cacheAt) return { bytes: input.weightsBytes, measured: undefined }
  return { bytes: measured.bytes - cacheAt, measured }
}

export function localWindowLoad(input: LocalWindowLoadInput, window: number): LocalWindowFitRung {
  const cacheBytes = kvCacheBytes(input.geometry, window, Math.max(1, Math.floor(input.slots ?? 1)), input.cacheType)
  const totalBytes = localWindowResident(input).bytes + cacheBytes
  return { window, cacheBytes, totalBytes, fits: totalBytes <= input.usableBytes }
}

export function localWindowFitWords(fit: Omit<LocalWindowFit, 'words'>): string {
  const resident = localWindowResident(fit)
  const moreCache = resident.measured === undefined ? 0 : fit.totalBytes - resident.measured.bytes
  const delta = moreCache > 0 ? ` + ${gibWords(moreCache)} more cache` : moreCache < 0 ? ` − ${gibWords(-moreCache)} less cache` : ''
  const parts = resident.measured === undefined ? `${gibWords(fit.weightsBytes)} weights + ${gibWords(fit.cacheBytes)} cache` : `${gibWords(resident.measured.bytes)} measured at ${tokensWords(resident.measured.window)}${delta}`
  const box = `${gibWords(fit.machineBytes)} box`
  const tail = ` · ${fit.cacheType} · ${fit.slots} slot${fit.slots === 1 ? '' : 's'}`
  if (!fit.fits) return `${tokensWords(fit.window)} · ${parts} — ${gibWords(fit.totalBytes)} does not fit in ${gibWords(fit.usableBytes)} usable (${box})${tail}`
  const next = fit.ladder.find(rung => rung.window > fit.window && !rung.fits)
  const refused = !fit.atMax && next !== undefined ? ` · ${tokensWords(next.window)} does not fit (${gibWords(next.totalBytes)})` : ''
  const sum = resident.measured !== undefined && delta !== '' ? ` = ${gibWords(fit.totalBytes)}` : ''
  return `${tokensWords(fit.window)} · ${parts}${sum} of ${gibWords(fit.usableBytes)} usable (${box})${tail}${refused}`
}

export function fitLocalWindow(input: LocalWindowFitInput): LocalWindowFit {
  const slots = Math.max(1, Math.floor(input.slots ?? 1))
  const cacheType = (input.cacheType ?? KV_CACHE_DEFAULT_TYPE).toLowerCase()
  const project: LocalWindowLoadInput = { weightsBytes: input.weightsBytes, geometry: input.geometry, usableBytes: input.usableBytes, slots, cacheType, ...(input.measured !== undefined ? { measured: input.measured } : {}) }
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
    ...(input.measured !== undefined ? { measured: input.measured } : {}),
    ladder,
  }
  return { ...fit, words: localWindowFitWords(fit) }
}

export function localWindowRefusal(fit: LocalWindowFit, window: number): string | undefined {
  const load = localWindowLoad(fit, window)
  if (load.fits) return undefined
  return `${gibWords(load.totalBytes)} does not fit ${gibWords(fit.usableBytes)} usable · ${fit.fits ? `${tokensWords(fit.window)} fits` : 'no rung fits'}`
}

export const SMALL_MACHINE_BYTES = 16 * 1024 ** 3
export const LOCAL_WINDOW_ROOM_FRACTION = 0.1
export const LOCAL_WINDOW_ROOM_FLOOR_BYTES = 1024 ** 3

export function smallMachine(machineBytes: number): boolean {
  return machineBytes < SMALL_MACHINE_BYTES
}

export function localWindowRoomFloor(usableBytes: number): number {
  return Math.max(usableBytes * LOCAL_WINDOW_ROOM_FRACTION, LOCAL_WINDOW_ROOM_FLOOR_BYTES)
}

export function localWindowRoomWarning(fit: LocalWindowFit, window: number): string | undefined {
  if (!smallMachine(fit.machineBytes)) return undefined
  const load = localWindowLoad(fit, window)
  if (!load.fits) return undefined
  const floor = localWindowRoomFloor(fit.usableBytes)
  const roomOf = (rung: LocalWindowFitRung): number => fit.usableBytes - rung.totalBytes
  if (roomOf(load) >= floor) return undefined
  const smaller = fit.ladder.filter(rung => rung.window < window && rung.fits && roomOf(rung) >= floor).at(-1)
  const suggestion = smaller === undefined ? 'no smaller rung leaves room' : `${tokensWords(smaller.window)} leaves ${gibWords(roomOf(smaller))}`
  return `${tokensWords(window)} leaves ${gibWords(roomOf(load))} of ${gibWords(fit.usableBytes)} usable (${gibWords(fit.machineBytes)} box) · ${suggestion}`
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

export function serverMeasuredOf(truth: LocalServerTruth | null, name: string): LocalWindowMeasured | undefined {
  const loaded = truth?.loaded.find(model => model.name === name)
  const bytes = loaded?.sizeBytes ?? loaded?.sizeVramBytes
  if (loaded === undefined || bytes === undefined || !(bytes > 0) || loaded.contextLength === undefined) return undefined
  return { bytes, window: loaded.contextLength, slots: serverSlotsOf(truth) }
}

export function fitLocalWindowOn(truth: LocalServerTruth, model: { name: string; weightsBytes: number; geometry: KvGeometry; trainedMax?: number; measured?: LocalWindowMeasured }, slots: number = serverSlotsOf(truth), cacheType: string | undefined = serverCacheTypeOf(truth)): LocalWindowFit {
  const measured = serverMeasuredOf(truth, model.name) ?? model.measured
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
    ...(measured !== undefined ? { measured } : {}),
  })
}
