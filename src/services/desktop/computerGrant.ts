import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameWithWin32RetrySync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'

export const COMPUTER_GRANT_FILE = 'computer-grant.json'
export const COMPUTER_GRANT_HOURS = [1, 24] as const
export type ComputerGrantHours = (typeof COMPUTER_GRANT_HOURS)[number]
export const HOUR_MS = 3_600_000

export type ComputerGrantRecord = { version: 1; kind: 'timed'; hours: ComputerGrantHours; grantedAt: number; until: number }

function sessionSegment(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.:-]+/g, '-') || 'session'
}

export function computerGrantPath(sessionId: string, home: string = getMercuryHome()): string {
  return join(home, 'sessions', sessionSegment(sessionId), COMPUTER_GRANT_FILE)
}

export function timedComputerGrant(hours: ComputerGrantHours, now: number = Date.now()): ComputerGrantRecord {
  return { version: 1, kind: 'timed', hours, grantedAt: now, until: now + hours * HOUR_MS }
}

export function writeComputerGrant(sessionId: string, record: ComputerGrantRecord, home: string = getMercuryHome()): void {
  const path = computerGrantPath(sessionId, home)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameWithWin32RetrySync(temporary, path)
}

export function clearComputerGrant(sessionId: string, home: string = getMercuryHome()): void {
  try {
    unlinkSync(computerGrantPath(sessionId, home))
  } catch {
    return
  }
}

function recordOf(raw: string): ComputerGrantRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.version !== 1 || typeof o.grantedAt !== 'number') return null
  if (o.kind === 'timed' && typeof o.until === 'number' && (o.hours === 1 || o.hours === 24)) {
    return { version: 1, kind: 'timed', hours: o.hours, grantedAt: o.grantedAt, until: o.until }
  }
  return null
}

export function readComputerGrant(sessionId: string, now: number = Date.now(), home: string = getMercuryHome()): ComputerGrantRecord | null {
  let raw: string
  try {
    raw = readFileSync(computerGrantPath(sessionId, home), 'utf8')
  } catch {
    return null
  }
  const record = recordOf(raw)
  if (record === null) {
    logForDebugging(`computer grant: ${computerGrantPath(sessionId, home)} is not a grant record — ignored`)
    return null
  }
  if (record.until <= now) {
    clearComputerGrant(sessionId, home)
    return null
  }
  return record
}

export function computerGrantRemainingMs(record: ComputerGrantRecord, now: number = Date.now()): number {
  return Math.max(0, record.until - now)
}

export function computerGrantWords(record: ComputerGrantRecord, now: number = Date.now()): string {
  const left = Math.ceil(computerGrantRemainingMs(record, now) / 60_000)
  const span = record.hours === 1 ? '1 hour' : '24 hours'
  return `granted for ${span} · ${left >= 90 ? `${Math.round(left / 60)}h` : `${left}m`} left`
}
