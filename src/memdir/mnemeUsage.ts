import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { mnemeLibraryDir } from './mnemeGates.js'

export const PINNED_LIMIT = 10

export interface PinRecord {
  seq: number
  at: string
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
    return parsed.pins.filter(p => Number.isInteger(p?.seq) && p.seq > 0 && typeof p?.at === 'string')
  } catch {
    return []
  }
}

export function writePins(pins: readonly PinRecord[], dir: string = mnemeLibraryDir()): void {
  const file: PinsFile = { version: 1, pins: [...pins] }
  durableAtomicPublishSync(pinsPath(dir), JSON.stringify(file, null, 1))
}

export function isPinned(seq: number, dir: string = mnemeLibraryDir()): boolean {
  return readPins(dir).some(p => p.seq === seq)
}

export function pinFact(seq: number, dir: string = mnemeLibraryDir(), now: Date = new Date()): { ok: boolean; pinned: number } {
  const pins = readPins(dir)
  if (!pins.some(p => p.seq === seq)) {
    pins.push({ seq, at: now.toISOString() })
    writePins(pins, dir)
  }
  return { ok: true, pinned: pins.length }
}

export function unpinFact(seq: number, dir: string = mnemeLibraryDir()): { ok: boolean; pinned: number } {
  const pins = readPins(dir)
  const kept = pins.filter(p => p.seq !== seq)
  if (kept.length !== pins.length) writePins(kept, dir)
  return { ok: true, pinned: kept.length }
}

export function movePin(fromSeq: number, toSeq: number, dir: string = mnemeLibraryDir()): boolean {
  const pins = readPins(dir)
  const at = pins.findIndex(p => p.seq === fromSeq)
  if (at < 0) return false
  pins[at] = { seq: toSeq, at: pins[at]!.at }
  writePins(pins, dir)
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
    durableAtomicPublishSync(usagePath(dir), JSON.stringify(file))
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
