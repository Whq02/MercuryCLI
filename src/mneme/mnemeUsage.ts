import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { publishLibraryFile } from './mnemeLibrary.js'

export const PINNED_TEXT_LIMIT_DEFAULT = 8000
export const PINNED_TEXT_LIMIT_MIN = 1000
export const PINNED_TEXT_LIMIT_STEP = 1000

export function pinnedTextLimit(): number {
  const raw: unknown = getInitialSettings().memory?.pinnedLimit
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= PINNED_TEXT_LIMIT_MIN) return Math.floor(raw)
  return PINNED_TEXT_LIMIT_DEFAULT
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

export function readPins(dir: string = mnemeLibraryDir()): PinRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(pinsPath(dir), 'utf8')) as PinsFile
    if (!Array.isArray(parsed?.pins)) return []
    return parsed.pins
      .filter(p => Number.isInteger(p?.seq) && p.seq > 0 && typeof p?.at === 'string')
      .map(p => ({ seq: p.seq, at: p.at, ...(p.asked === true ? { asked: true as const } : {}) }))
  } catch {
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

export type PinOutcome = { ok: true; pinned: number }

export function pinFact(
  seq: number,
  dir: string = mnemeLibraryDir(),
  now: Date = new Date(),
  opts: { asked?: boolean } = {},
): PinOutcome {
  const pins = readPins(dir)
  const existing = pins.find(p => p.seq === seq)
  if (existing) {
    if (opts.asked && !existing.asked) {
      existing.asked = true
      writePins(pins, dir)
    }
    return { ok: true, pinned: pins.length }
  }
  pins.push({ seq, at: now.toISOString(), ...(opts.asked ? { asked: true as const } : {}) })
  writePins(pins, dir)
  return { ok: true, pinned: pins.length }
}

export function unpinFact(seq: number, dir: string = mnemeLibraryDir()): { ok: boolean; pinned: number } {
  const pins = readPins(dir)
  const kept = pins.filter(p => p.seq !== seq)
  if (kept.length !== pins.length) writePins(kept, dir)
  return { ok: true, pinned: kept.length }
}

export function movePin(fromSeq: number, toSeq: number, dir: string = mnemeLibraryDir(), asked?: boolean): boolean {
  const pins = readPins(dir)
  const at = pins.findIndex(p => p.seq === fromSeq)
  if (at < 0) return false
  const already = pins.find(p => p.seq === toSeq)
  const kept = pins.filter((p, i) => i === at || p.seq !== toSeq)
  const slot = kept.findIndex(p => p.seq === fromSeq)
  const prior = kept[slot]!
  kept[slot] = { seq: toSeq, at: prior.at, ...(prior.asked || already?.asked || asked ? { asked: true as const } : {}) }
  writePins(kept, dir)
  return true
}

export function readUsage(dir: string = mnemeLibraryDir()): Record<string, UsageRecord> {
  if (!existsSync(usagePath(dir))) return {}
  try {
    const parsed = JSON.parse(readFileSync(usagePath(dir), 'utf8')) as UsageFile
    return parsed?.rows && typeof parsed.rows === 'object' ? parsed.rows : {}
  } catch {
    return {}
  }
}

export function bumpUsage(seqs: readonly number[], dir: string = mnemeLibraryDir(), now: Date = new Date()): void {
  const distinct = [...new Set(seqs.filter(s => Number.isInteger(s) && s > 0))]
  if (distinct.length === 0) return
  try {
    const rows = readUsage(dir)
    const stamp = now.toISOString()
    for (const seq of distinct) {
      const prior = rows[String(seq)]
      rows[String(seq)] = { last: stamp, count: (prior?.count ?? 0) + 1 }
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
