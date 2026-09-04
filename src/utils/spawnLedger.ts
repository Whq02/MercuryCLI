import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from './envUtils.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export const SPAWNED_BY_ENV = 'MERCURY_SPAWNED_BY'

export function isSpawnLedgerEnabled(): boolean {
  return flagEnv('MERCURY_SPAWN_LEDGER') !== '0'
}

export function isSpawnAuditEnabled(): boolean {
  return flagEnv('MERCURY_SPAWN_AUDIT') !== '0'
}

export function spawnedByStamp(kind: string, id: string): string {
  return `${kind}:${id}#${process.pid}`
}

export interface SpawnLedgerEntry {
  kind:
    | 'long-lived'
    | 'long-lived-refused'
    | 'headless'
    | 'headless-refused'
    | 'teammate'
    | 'teammate-refused'
  id: string
  cwd: string
  reason?: string
  role?: string
}

function forensicsDir(): string {
  const { daemonDir } = require('../daemon/controlSocket.js') as typeof import('../daemon/controlSocket.js')
  return daemonDir()
}

export function spawnLedgerPath(): string {
  return join(forensicsDir(), 'spawn-ledger.jsonl')
}

export function legacySpawnLedgerPath(): string {
  return join(getMercuryHome(), 'spawn-ledger.jsonl')
}

export function spawnLedgerPaths(): string[] {
  const live = spawnLedgerPath()
  const legacy = legacySpawnLedgerPath()
  return legacy !== live && existsSync(legacy) ? [live, legacy] : [live]
}

export function bashAuditPath(): string {
  return join(forensicsDir(), 'bash-audit.jsonl')
}

function appendTrail(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(row) + '\n')
}

export function recordSpawn(entry: SpawnLedgerEntry): void {
  if (!isSpawnLedgerEnabled()) return
  try {
    const row = {
      ts: new Date().toISOString(),
      spawnerPid: process.pid,
      spawnedBy: flagEnv(SPAWNED_BY_ENV) ?? 'operator-session',
      ...entry,
    }
    appendTrail(spawnLedgerPath(), row)
  } catch {
  }
}

export interface SpawnExitEntry {
  kind: 'long-lived' | 'headless' | 'teammate' | 'supervisor'
  event: 'exit' | 'reap'
  id: string
  pid?: number
  code?: number | null
  signal?: string | null
  outcome?: string
  reason?: string
}

export function recordSpawnExit(entry: SpawnExitEntry): void {
  if (!isSpawnLedgerEnabled()) return
  try {
    const row = {
      ts: new Date().toISOString(),
      spawnerPid: process.pid,
      spawnedBy: flagEnv(SPAWNED_BY_ENV) ?? 'operator-session',
      ...entry,
    }
    appendTrail(spawnLedgerPath(), row)
  } catch {
  }
}

export function assertSpawnCwd(cwd: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!cwd) return { ok: true }
  if (existsSync(cwd)) return { ok: true }
  return { ok: false, reason: `spawn cwd does not exist: ${cwd}` }
}

export function recordBashAudit(command: string, exitCode: number | null, interrupted: boolean): void {
  if (!isSpawnAuditEnabled()) return
  const spawnedBy = flagEnv(SPAWNED_BY_ENV)
  if (!spawnedBy) return
  try {
    const row = {
      ts: new Date().toISOString(),
      spawnedBy,
      pid: process.pid,
      cwd: process.cwd(),
      command: command.length > 600 ? command.slice(0, 600) + '…' : command,
      exitCode,
      interrupted,
    }
    appendTrail(bashAuditPath(), row)
  } catch {
  }
}
