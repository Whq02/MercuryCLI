import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { publishLibraryFile } from './mnemeLibrary.js'
import { clearMnemeUnread, recordMnemeUnread } from './mnemeUnread.js'
import { validatedApplicability, type MemoryApplicability } from './memoryApplicability.js'

export const PINNED_TEXT_LIMIT_DEFAULT = 8000
export const PINNED_TEXT_LIMIT_MIN = 1000
export const PINNED_TEXT_LIMIT_STEP = 1000

export function pinnedTextLimit(): number {
  const raw: unknown = getInitialSettings().memory?.pinnedLimit
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= PINNED_TEXT_LIMIT_MIN) return Math.floor(raw)
  return PINNED_TEXT_LIMIT_DEFAULT
}

export const START_TEXT_LIMIT_DEFAULT = 4000
export const START_TEXT_LIMIT_MIN = 1000
export const START_TEXT_LIMIT_STEP = 1000

export function startTextLimit(): number {
  const raw: unknown = getInitialSettings().memory?.startLimit
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= START_TEXT_LIMIT_MIN) return Math.floor(raw)
  return START_TEXT_LIMIT_DEFAULT
}

export function formatTextSize(chars: number): string {
  if (chars < 1000) return `${chars}`
  const k = chars / 1000
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`
}

export interface PinRecord {
  seq: number
  at: string
  asked?: true
  applicability?: MemoryApplicability
}

interface PinsFile {
  version: 1
  pins: PinRecord[]
}

export interface UsageRecord {
  last: string
  count: number
}

interface UsageFile {
  version: 1
  rows: Record<string, UsageRecord>
}

export function pinsPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'pins.json')
}

export function usagePath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'usage.json')
}

function readPinsStrict(dir: string): PinRecord[] {
  const p = pinsPath(dir)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    if (isENOENT(e)) return []
    throw e
  }
  const parsed = JSON.parse(raw) as PinsFile
  if (!Array.isArray(parsed?.pins)) {
    throw new Error(`memory pins unreadable at ${p}`)
  }
  return parsed.pins
    .filter(p => Number.isInteger(p?.seq) && p.seq > 0 && typeof p?.at === 'string')
    .map(p => ({ seq: p.seq, at: p.at, ...(p.asked === true ? { asked: true as const } : {}), ...(validatedApplicability(p.applicability) ? { applicability: validatedApplicability(p.applicability) } : {}) }))
}

export function readPins(dir: string = mnemeLibraryDir()): PinRecord[] {
  const p = pinsPath(dir)
  try {
    const pins = readPinsStrict(dir)
    clearMnemeUnread(p)
    return pins
  } catch (e) {
    recordMnemeUnread(p, e)
    logForDebugging(`memory pins unreadable at ${p}: ${e instanceof SyntaxError ? 'it is not valid JSON' : String(e)}`)
    passedOver(e)
    return []
  }
}

export function writePins(pins: readonly PinRecord[], dir: string = mnemeLibraryDir()): void {
  const file: PinsFile = { version: 1, pins: [...pins] }
  publishLibraryFile(pinsPath(dir), JSON.stringify(file, null, 1))
}

export function isPinned(seq: number, dir: string = mnemeLibraryDir()): boolean {
  return readPins(dir).some(p => p.seq === seq)
}

type PinOutcome = { ok: true; pinned: number }

export function pinFact(
  seq: number,
  dir: string = mnemeLibraryDir(),
  now: Date = new Date(),
  opts: { asked?: boolean; applicability?: MemoryApplicability } = {},
): PinOutcome {
  const pins = readPinsStrict(dir)
  const existing = pins.find(p => p.seq === seq)
  const applicability = validatedApplicability(opts.applicability)
  if (existing && applicability) existing.applicability = applicability
  if (existing) {
    if (applicability || opts.asked && !existing.asked) {
      if (opts.asked) existing.asked = true
      writePins(pins, dir)
    }
    return { ok: true, pinned: pins.length }
  }
  pins.push({ seq, at: now.toISOString(), ...(opts.asked ? { asked: true as const } : {}), ...(applicability ? { applicability } : {}) })
  writePins(pins, dir)
  return { ok: true, pinned: pins.length }
}

export function unpinFact(seq: number, dir: string = mnemeLibraryDir()): { ok: boolean; pinned: number } {
  const pins = readPinsStrict(dir)
  const kept = pins.filter(p => p.seq !== seq)
  if (kept.length !== pins.length) writePins(kept, dir)
  return { ok: true, pinned: kept.length }
}

export function movePin(fromSeq: number, toSeq: number, dir: string = mnemeLibraryDir(), asked?: boolean): boolean {
  const pins = readPinsStrict(dir)
  const at = pins.findIndex(p => p.seq === fromSeq)
  if (at < 0) return false
  const already = pins.find(p => p.seq === toSeq)
  const kept = pins.filter((p, i) => i === at || p.seq !== toSeq)
  const slot = kept.findIndex(p => p.seq === fromSeq)
  const prior = kept[slot]!
  kept[slot] = { ...prior, seq: toSeq, at: prior.at, ...(prior.asked || already?.asked || asked ? { asked: true as const } : {}) }
  writePins(kept, dir)
  return true
}

function readUsageStrict(dir: string): Record<string, UsageRecord> {
  const p = usagePath(dir)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    if (isENOENT(e)) return {}
    throw e
  }
  const parsed = JSON.parse(raw) as UsageFile
  if (!parsed?.rows || typeof parsed.rows !== 'object' || Array.isArray(parsed.rows)) {
    throw new Error(`memory usage unreadable at ${p}`)
  }
  return parsed.rows
}

export function readUsage(dir: string = mnemeLibraryDir()): Record<string, UsageRecord> {
  const p = usagePath(dir)
  try {
    const rows = readUsageStrict(dir)
    clearMnemeUnread(p)
    return rows
  } catch (e) {
    recordMnemeUnread(p, e)
    logForDebugging(`memory usage unreadable at ${p}: ${e instanceof SyntaxError ? 'it is not valid JSON' : String(e)}`)
    passedOver(e)
    return {}
  }
}

export function bumpUsage(seqs: readonly number[], dir: string = mnemeLibraryDir(), now: Date = new Date(), opened = true): void {
  const distinct = [...new Set(seqs.filter(s => Number.isInteger(s) && s > 0))]
  if (distinct.length === 0) return
  try {
    const rows = readUsageStrict(dir)
    const stamp = now.toISOString()
    for (const seq of distinct) {
      const prior = rows[String(seq)]
      rows[String(seq)] = { last: prior?.last && prior.last > stamp ? prior.last : stamp, count: (prior?.count ?? 0) + (opened ? 1 : 0) }
    }
    const file: UsageFile = { version: 1, rows }
    publishLibraryFile(usagePath(dir), JSON.stringify(file))
  } catch (e) {
    logForDebugging(`memory usage bump failed: ${String(e)}`)
  }
}

export function usageOf(seq: number, usage: Record<string, UsageRecord>): UsageRecord {
  return usage[String(seq)] ?? { last: '', count: 0 }
}

export function lastUsedMs(seq: number, observedIso: string, usage: Record<string, UsageRecord>): number {
  const observed = Date.parse(observedIso)
  const used = Date.parse(usageOf(seq, usage).last)
  const a = Number.isFinite(observed) ? observed : 0
  const b = Number.isFinite(used) ? used : 0
  return Math.max(a, b)
}
