import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import { localWindowRungs } from '../localServer/localWindowFit.js'
import type { TensorFoldFit, TensorFoldFitParts, TensorFoldLadderRung } from './contracts.js'
import { GIB, TENSORFOLD_AGENT_FLOOR, TENSORFOLD_RAISED_LIMIT_BELOW_BYTES, TENSORFOLD_RAISED_LIMIT_REPOS, TENSORFOLD_RUNTIME_MARGIN, type TensorFoldCheckpoint } from './starting.js'

export const TENSORFOLD_ADMISSION_SHARE = 0.7
export const TENSORFOLD_PROMPT_CACHE_CAP_GIB = 16
export const WIRED_LIMIT_MARGIN_BYTES = 4 * GIB
export const WIRED_LIMIT_OS_FLOOR_BYTES = 4 * GIB
export const WIRED_LIMIT_TIGHT_BYTES = 8 * GIB
export const METAL_WORKING_SET_SCRIPT = "ObjC.import('Metal'); var d = $.MTLCreateSystemDefaultDevice(); d ? String(d.recommendedMaxWorkingSetSize) + ' ' + d.name.js : ''"

export type TensorFoldUsableSource = 'metal' | 'wired-limit' | 'seventy-percent' | 'cuda' | 'available'

export type TensorFoldMachineTruth = {
  platform: NodeJS.Platform
  ramBytes: number
  usableBytes: number
  usableSource: TensorFoldUsableSource
  chip: string
  gpu?: { name: string; memoryBytes: number; driver?: string; cuda?: string }
  wiredLimitMib?: number
  osVersion?: string
}

export type MachineIo = {
  platform?: NodeJS.Platform
  ramBytes?: number
  run?: (file: string, args: string[]) => Promise<string | undefined>
}

function defaultRun(file: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: 4_000, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? undefined : String(stdout)))
    } catch {
      resolve(undefined)
    }
  })
}

const positive = (value: unknown): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function parseMetalWorkingSet(text: string | undefined): { bytes: number; name: string } | undefined {
  const match = /^\s*(\d+)\s*(.*?)\s*$/s.exec(text ?? '')
  if (!match) return undefined
  const bytes = positive(match[1])
  return bytes === undefined ? undefined : { bytes, name: match[2] ?? '' }
}

export function parseNvidiaSmiLine(text: string | undefined): { name: string; memoryBytes: number; driver?: string } | undefined {
  const line = (text ?? '').split('\n').map(row => row.trim()).find(row => row !== '')
  if (line === undefined) return undefined
  const [name, mib, driver] = line.split(',').map(cell => cell.trim())
  const memory = positive(mib)
  if (!name || memory === undefined) return undefined
  return { name, memoryBytes: Math.round(memory * 1024 * 1024), ...(driver ? { driver } : {}) }
}

export function cudaReserveBytes(cardBytes: number): number {
  return Math.max(GIB, Math.round(cardBytes / 32))
}

export function cudaVersionOfDriver(driver: string | undefined): string | undefined {
  const major = Number(driver?.split('.')[0])
  if (!Number.isFinite(major)) return undefined
  return major >= 580 ? '13' : major >= 525 ? '12' : '11'
}

export async function readTensorFoldMachineTruth(io: MachineIo = {}): Promise<TensorFoldMachineTruth> {
  const platform = io.platform ?? process.platform
  const ramBytes = io.ramBytes ?? totalmem()
  const run = io.run ?? defaultRun
  const seventy = { usableBytes: Math.round(ramBytes * TENSORFOLD_ADMISSION_SHARE), usableSource: 'seventy-percent' as const }
  if (platform === 'darwin') {
    const osVersion = (await run('sysctl', ['-n', 'kern.osproductversion']))?.trim()
    const wiredText = (await run('sysctl', ['-n', 'iogpu.wired_limit_mb']))?.trim()
    const wired = wiredText !== undefined && /^\d+$/.test(wiredText) ? Number(wiredText) : undefined
    const brand = (await run('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim()
    const metal = parseMetalWorkingSet(await run('osascript', ['-l', 'JavaScript', '-e', METAL_WORKING_SET_SCRIPT]))
    const chip = metal?.name || brand || 'Apple silicon'
    const base = { platform, ramBytes, chip, ...(osVersion ? { osVersion } : {}), ...(wired !== undefined ? { wiredLimitMib: wired } : {}) }
    if (metal !== undefined) return { ...base, usableBytes: metal.bytes, usableSource: 'metal' }
    if (wired !== undefined && wired > 0) return { ...base, usableBytes: Math.round(wired * 1024 * 1024), usableSource: 'wired-limit' }
    return { ...base, ...seventy }
  }
  if (platform === 'linux') {
    const card = parseNvidiaSmiLine(await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']))
    if (card !== undefined) {
      const cuda = cudaVersionOfDriver(card.driver)
      return { platform, ramBytes, chip: card.name, gpu: { ...card, ...(cuda !== undefined ? { cuda } : {}) }, usableBytes: card.memoryBytes - cudaReserveBytes(card.memoryBytes), usableSource: 'cuda' }
    }
    return { platform, ramBytes, chip: 'no NVIDIA GPU found', ...seventy }
  }
  return { platform, ramBytes, chip: platform === 'win32' ? 'Windows' : platform, ...seventy }
}

export function tensorFoldFloorBytes(point: Pick<TensorFoldCheckpoint, 'weightsBytes' | 'drafter'>): number {
  return point.weightsBytes + (point.drafter?.weightsBytes ?? 0) + TENSORFOLD_RUNTIME_MARGIN
}

export function tensorFoldProjectedBytes(point: Pick<TensorFoldCheckpoint, 'weightsBytes' | 'drafter' | 'kvBytesPerToken' | 'promptCacheGib'>, window: number): number {
  return tensorFoldFloorBytes(point) + point.kvBytesPerToken * window + (point.promptCacheGib ?? 0) * GIB
}

export function tensorFoldRungs(point: Pick<TensorFoldCheckpoint, 'trainedMax'>): number[] {
  return localWindowRungs(point.trainedMax).filter(window => window <= point.trainedMax)
}

export function gibOf(bytes: number): number {
  return bytes / GIB
}

export function fitPartsOf(point: TensorFoldCheckpoint, window: number): TensorFoldFitParts {
  const cacheCapped = point.promptCacheGib === undefined
  return {
    weightsGib: gibOf(point.weightsBytes),
    ...(point.drafter !== undefined ? { drafterGib: gibOf(point.drafter.weightsBytes) } : {}),
    cacheGib: gibOf(point.kvBytesPerToken * window),
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
    ...(cacheCapped ? { promptCacheCapGib: TENSORFOLD_PROMPT_CACHE_CAP_GIB } : {}),
    runtimeGib: gibOf(TENSORFOLD_RUNTIME_MARGIN),
  }
}

export type WiredLimitOffer = { limitMib: number; leavesBytes: number; tight: boolean }

export function wiredLimitOfferFor(neededBytes: number, machine: Pick<TensorFoldMachineTruth, 'ramBytes' | 'platform'>): WiredLimitOffer | null {
  if (machine.platform !== 'darwin') return null
  const limit = neededBytes + WIRED_LIMIT_MARGIN_BYTES
  const leavesBytes = machine.ramBytes - limit
  if (leavesBytes < WIRED_LIMIT_OS_FLOOR_BYTES) return null
  return { limitMib: Math.ceil(limit / (1024 * 1024)), leavesBytes, tight: leavesBytes < WIRED_LIMIT_TIGHT_BYTES }
}

export const LOWER_OR_SMALLER = 'lower the window or choose a smaller model'

export function wiredLimitRemedyWords(offer: WiredLimitOffer | null): string {
  if (offer === null) return LOWER_OR_SMALLER
  return `sudo sysctl iogpu.wired_limit_mb=${offer.limitMib} · resets at reboot; restart the engine after it${offer.tight ? ' · tight — quit other apps first' : ''}`
}

export function fitTensorFold(point: TensorFoldCheckpoint, window: number, machine: TensorFoldMachineTruth): TensorFoldFit {
  const neededBytes = tensorFoldProjectedBytes(point, window)
  const base = { neededGib: gibOf(neededBytes), availableGib: gibOf(machine.usableBytes), estimate: true as const, parts: fitPartsOf(point, window) }
  const admission = Math.round(machine.ramBytes * TENSORFOLD_ADMISSION_SHARE)
  if (tensorFoldFloorBytes(point) > admission) {
    return { ...base, verdict: 'too-big', reason: `its floor is past 70% of this machine's memory`, remedy: 'choose a smaller model' }
  }
  const raisedLimit = machine.platform === 'darwin' && TENSORFOLD_RAISED_LIMIT_REPOS.has(point.repo) && machine.ramBytes < TENSORFOLD_RAISED_LIMIT_BELOW_BYTES
  if (neededBytes <= machine.usableBytes && !raisedLimit) return { ...base, verdict: 'fits' }
  if (machine.platform === 'darwin') {
    const offer = wiredLimitOfferFor(neededBytes, machine)
    return { ...base, verdict: 'needs-gpu-limit', reason: raisedLimit ? 'needs the GPU limit raised on a Mac under 48 GB' : 'past what macOS lets the GPU wire', remedy: wiredLimitRemedyWords(offer) }
  }
  return { ...base, verdict: 'too-big', reason: 'more than this GPU holds', remedy: LOWER_OR_SMALLER }
}

export function tensorFoldLadder(point: TensorFoldCheckpoint, machine: TensorFoldMachineTruth): TensorFoldLadderRung[] {
  return tensorFoldRungs(point).map(window => ({ window, fit: fitTensorFold(point, window, machine) }))
}

export function chosenTensorFoldWindow(ladder: readonly TensorFoldLadderRung[]): number {
  const fitting = ladder.filter(rung => rung.fit.verdict === 'fits')
  return fitting.length > 0 ? fitting[fitting.length - 1]!.window : (ladder[0]?.window ?? TENSORFOLD_AGENT_FLOOR)
}

export function reachesAgentFloor(ladder: readonly TensorFoldLadderRung[]): boolean {
  return ladder.some(rung => rung.window >= TENSORFOLD_AGENT_FLOOR && rung.fit.verdict === 'fits')
}
