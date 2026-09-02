// ============================================================================
//  daemon/carryForward — the respawn task-state handoff.
//  The roster's auto-clear respawns a long-lived worker with a FRESH
//  transcript at a context ceiling — correct for context health, but the
//  task state dies with the transcript and the operator sees a silent
//  reset. This seeds ONE durable note into the fresh child's inbox (journal-
//  first, at-least-once) that (a) tells it it was respawned mid-program and
//  anchors the most recent dispatch id, and (b) renders as one chat line (a
//  'note' envelope is operator/daemon-voiced by protocol), so the operator
//  SEES the continuity instead of inferring it.
//
//  Flag: MERCURY_CARRY_FORWARD — default-ON (tier `additive` — the note only
//  ADDS a daemon-voiced handoff line to a respawn that would otherwise start
//  cold; worst case is a stale advisory line, bounded by the note being
//  built from the roster's own journal). `=0` opts out ⇒ auto-clear behaves
//  byte-identically (no note, no chat line). Pure builders here (provable);
//  the roster owns the send.
// ============================================================================

import { buildNote, type NoteEnvelope } from '../utils/swarm/busEnvelopes.js'
import { flagEnv } from '../substrate/flagRegistry.js'

export function carryForwardEnabled(): boolean {
  if (flagEnv('MERCURY_CARRY_FORWARD') === '0') return false
  return true
}

/** The one-line handoff note. `from` is the daemon (protocol: a note is never
 *  worker-voiced); the most recent dispatch id (when known) anchors the task
 *  the fresh child should re-orient on. */
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

/** The most recent id in the roster's seen-dispatch Set (insertion-ordered). */
export function lastSeenDispatchId(seen: Set<string> | undefined): string | undefined {
  if (!seen || seen.size === 0) return undefined
  let last: string | undefined
  for (const v of seen) last = v
  return last
}
