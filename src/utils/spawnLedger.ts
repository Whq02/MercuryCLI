import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
  const seam = flagEnv('MERCURY_DAEMON_DIR')
  if (seam && seam.trim() !== '') return seam
  return getMercuryHome()
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
    appendFileSync(join(forensicsDir(), 'spawn-ledger.jsonl'), JSON.stringify(row) + '\n')
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
    appendFileSync(join(forensicsDir(), 'spawn-ledger.jsonl'), JSON.stringify(row) + '\n')
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
    appendFileSync(join(forensicsDir(), 'bash-audit.jsonl'), JSON.stringify(row) + '\n')
  } catch {
  }
}
