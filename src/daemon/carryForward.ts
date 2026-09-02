
import { buildNote, type NoteEnvelope } from '../utils/swarm/busEnvelopes.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export function carryForwardEnabled(): boolean {
  if (flagEnv('MERCURY_CARRY_FORWARD') === '0') return false
  return true
}

export function buildCarryForwardNote(
  ctxPct: number | undefined,
  lastDispatchId: string | undefined,
): NoteEnvelope {
  const pct = typeof ctxPct === 'number' ? `${Math.round(ctxPct)}%` : 'the ceiling'
  const anchor = lastDispatchId ? ` Your most recent dispatch was ${lastDispatchId} —` : ''
  return buildNote(
    'daemon',
    `carry-forward: your context hit ${pct}, so you were respawned with a fresh transcript (auto-clear).` +
      `${anchor} re-read the recent conversation before continuing, finish or restate any in-flight work, ` +
      `and report your current task state to the team-lead so nothing is silently dropped.`,
    lastDispatchId ? { refRequestId: lastDispatchId } : undefined,
  )
}

export function lastSeenDispatchId(seen: Set<string> | undefined): string | undefined {
  if (!seen || seen.size === 0) return undefined
  let last: string | undefined
  for (const v of seen) last = v
  return last
}
