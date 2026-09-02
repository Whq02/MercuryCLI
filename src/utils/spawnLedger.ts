// ============================================================================
// spawnLedger — post-incident spawn provenance + autonomous audit.
//
// The stray-agent incident cost an hour of process forensics because nothing
// recorded WHO spawned each agent or WHAT an autonomous child ran. Two
// append-only JSONL trails close that gap:
//   <config-home>/spawn-ledger.jsonl — one row per autonomously spawned child
//     (daemon long-lived workers, per-fire headless runs, teammates), written
//     by the SPAWNER at the spawn chokepoints, PLUS one `event:'exit'|'reap'`
//     row when a spawned child's life ends (the ledger shows spawn AND
//     exit — 'exit' when the process end was observed with code/signal,
//     'reap' when the spawner removed/killed it without observing the exit,
//     e.g. the daemon-shutdown worker reap). Opt out: MERCURY_SPAWN_LEDGER=0.
//   <config-home>/bash-audit.jsonl — one row per Bash command executed by a
//     SPAWNED child (MERCURY_SPAWNED_BY present — operator-driven sessions
//     never write it). Opt out: MERCURY_SPAWN_AUDIT=0.
// Both writers swallow every error: a forensics trail must never block a
// spawn or a tool call. assertSpawnCwd is the dead-cwd refusal shared by the
// spawn chokepoints — a roster row whose cwd does not exist must degrade
// loudly instead of entering a spawn→insta-die→respawn loop.
// ============================================================================
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

/** `kind:id#spawnerPid` — the value stamped into a child's MERCURY_SPAWNED_BY. */
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
  /** Present on refusals — why the spawn did not happen. */
  reason?: string
  role?: string
}

/** The forensics home: the daemon-dir hermetic seam when set — proof captures
 *  pin MERCURY_DAEMON_DIR, and gate runs were appending fake rows (scratch
 *  breaker/roster children) to the operator's REAL incident-attribution trail
 *  Unset ⇒ the config home, unchanged. */
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
    /* forensics must never block a spawn */
  }
}

export interface SpawnExitEntry {
  /** The spawn-site family the row pairs with (by `id`); 'supervisor' rows
   *  record the daemon supervisor's OWN teardown (the sync exit backstop). */
  kind: 'long-lived' | 'headless' | 'teammate' | 'supervisor'
  /** 'exit': the child's process end was observed (code/signal recorded);
   *  'reap': the spawner removed/killed it without observing the exit. */
  event: 'exit' | 'reap'
  id: string
  pid?: number
  code?: number | null
  signal?: string | null
  /** Settle disposition at the recording site (ok · failed · killed ·
   *  crash-respawn · reconfigure-respawn · degraded · timeout · …). */
  outcome?: string
  reason?: string
}

/** Append one exit/reap row when a spawned child's life ends (spawn AND
 *  exit are lookups, not forensics). Synchronous + swallow-all like every
 *  writer here — teardown paths call this and must never block or throw. */
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
    /* forensics must never block a teardown */
  }
}

/** Dead-cwd refusal shared by every spawn chokepoint. Undefined cwd is fine
 *  (the child inherits the spawner's cwd); a NAMED cwd must exist. */
export function assertSpawnCwd(cwd: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!cwd) return { ok: true }
  if (existsSync(cwd)) return { ok: true }
  return { ok: false, reason: `spawn cwd does not exist: ${cwd}` }
}

/** Append one Bash-command row when running as a SPAWNED child. Operator
 *  sessions (no MERCURY_SPAWNED_BY) never write — this audits autonomy only. */
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
    /* forensics must never block a tool call */
  }
}
