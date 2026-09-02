// ============================================================================
//  contextLanes/lanes — bounded side contexts with typed handoffs
// layered on the EXISTING /branch transcript fork (no
//  second fork engine, no second session writer).
//
//  A lane is a forked session with a GOAL and a BOUNDARY:
//    · the boundary rides a per-turn attachment (lane_boundary) — it is
//      re-asserted on EVERY request in the child, so compaction/context
//      rebuilds can never lose it by construction;
//    · parent task/reminder state never follows — the child session id owns
//      its own task list, drafts, context epochs, Workshop owners (all
//      session-keyed); the boundary SAYS so to the model;
//    · returning mints a HandoffEnvelope (answer + observed changedPaths
//      from the child's receipts + refs + unresolved) persisted on the lane
//      record; promotion into the parent is EXACTLY-ONCE (a durable
//      promoted flag);
//    · lanes are addressable as mercury://lane/<id>; dropping a lane never
//      touches project files or the child transcript.
// ============================================================================

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome, isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { receiptsFor } from '../changeTransaction/receipts.js'
import { processOwnerForLane } from '../run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  classifyReadFailure,
  sourceEmpty,
  sourceReady,
  valueOr,
  type SourceState,
} from '../../substrate/sourceState.js'

export function lanesEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_LANES'))
}

export interface HandoffEnvelope {
  laneId: string
  answer: string
  findings: string[]
  /** OBSERVED in the child (its receipt ring), never prose claims. */
  changedPaths: string[]
  refs: string[]
  unresolved: string[]
  recommendedParentAction?: string
  returnedAt: number
  promoted: boolean
}

export interface ContextLane {
  schema: 1
  id: string
  parentSessionId: string
  childSessionId: string
  goal: string
  selectedContextRefs: string[]
  /** What the boundary explicitly EXCLUDES from the parent. */
  excludedState: string[]
  createdAt: number
  status: 'active' | 'returned' | 'dropped'
  boundaryRevision: number
  handoff?: HandoffEnvelope
  updatedAt: number
}

// ── storage (durable, project-independent — keyed by parent session) ────────

function lanesDir(): string {
  return path.join(getMercuryHome(), 'lanes')
}

function lanePath(id: string): string {
  return path.join(lanesDir(), `${id}.json`)
}

function writeLane(lane: ContextLane): void {
  mkdirSync(lanesDir(), { recursive: true })
  durableAtomicPublishSync(lanePath(lane.id), JSON.stringify(lane, null, 2))
  // The one same-process mutation point invalidates the round memo directly
  // (the ripgrep resolvedConfig self-heal shape); foreign-process writes are
  // caught by the dir-mtime key below.
  laneScanMemo = null
}

// ── the per-round lookup memo ───────────────────────────────────────────────
// laneForChildSession rides the per-tool-round attachment collection of
// EVERY interactive session (the lane_boundary producer), and the scan it
// wraps read + parsed every lane file each round — thrown away immediately
// on the overwhelming majority of sessions, growing with machine age (lane
// files are never pruned). The memo keys on the lanes DIRECTORY's mtime:
// every lane write is an atomic temp+rename publish, and a rename always
// moves the directory's mtime, so a PARENT process's create/return/drop is
// seen by the CHILD's next round — a bare memo invalidated only at this
// process's writeLane would go cross-process-stale (the parent writes the
// lane the child reads). Ordinary sessions pay ONE stat per round, total.
let laneScanMemo: { dirMtimeMs: number; byChild: Map<string, ContextLane | null> } | null = null

function lanesDirMtimeMs(): number {
  try {
    return statSync(lanesDir()).mtimeMs
  } catch {
    // No lanes directory: -1 is a stable key (its creation changes it).
    return -1
  }
}

export function readLane(id: string): ContextLane | null {
  try {
    const lane = JSON.parse(readFileSync(lanePath(id), 'utf8')) as ContextLane
    return lane.schema === 1 && lane.id ? lane : null
  } catch {
    return null
  }
}

/**
 * The enumeration WITH its read outcome. An absent lanes
 * directory is a genuine emptiness; one that exists and cannot be enumerated
 * is a source we could not observe.
 */
export function listLanesSource(filter?: {
  parentSessionId?: string
  childSessionId?: string
}): SourceState<ContextLane[]> {
  try {
    if (!existsSync(lanesDir())) return sourceEmpty()
    const lanes = readdirSync(lanesDir())
      .filter(f => f.endsWith('.json'))
      .map(f => readLane(f.slice(0, -5)))
      .filter((l): l is ContextLane => l !== null)
      .filter(
        l =>
          (!filter?.parentSessionId || l.parentSessionId === filter.parentSessionId) &&
          (!filter?.childSessionId || l.childSessionId === filter.childSessionId),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
    return lanes.length === 0 ? sourceEmpty() : sourceReady(lanes)
  } catch (e) {
    return classifyReadFailure(e)
  }
}

/** Value-or-empty view — a `[]` here may mean the directory was unreadable.
 *  Callers that render a count should take listLanesSource instead. */
export function listLanes(filter?: {
  parentSessionId?: string
  childSessionId?: string
}): ContextLane[] {
  return valueOr(listLanesSource(filter), [])
}

/** The lane whose CHILD session is the given one (the boundary producer's
 *  per-round lookup). Memoized on the lanes dir's mtime — see the memo's
 *  note above; the freshness grain is the directory timestamp, which every
 *  atomic lane publish moves. */
export function laneForChildSession(sessionId: string): ContextLane | null {
  const dirMtimeMs = lanesDirMtimeMs()
  if (laneScanMemo !== null && laneScanMemo.dirMtimeMs === dirMtimeMs) {
    const held = laneScanMemo.byChild.get(sessionId)
    if (held !== undefined) return held
  } else {
    laneScanMemo = { dirMtimeMs, byChild: new Map() }
  }
  const active = listLanes({ childSessionId: sessionId })
  const lane = active.find(l => l.status === 'active') ?? active[0] ?? null
  laneScanMemo.byChild.set(sessionId, lane)
  return lane
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export function createLane(args: {
  parentSessionId: string
  childSessionId: string
  goal: string
  selectedContextRefs?: string[]
}): ContextLane {
  const lane: ContextLane = {
    schema: 1,
    id: `lane-${randomBytes(5).toString('hex')}`,
    parentSessionId: args.parentSessionId,
    childSessionId: args.childSessionId,
    goal: args.goal,
    selectedContextRefs: args.selectedContextRefs ?? [],
    excludedState: [
      "the parent's pending task list and reminders (this lane's session owns a fresh one)",
      "the parent's run/deliverable state and continuation obligations",
      "the parent's Workshop runtimes and drafts (session-owned)",
    ],
    createdAt: Date.now(),
    status: 'active',
    boundaryRevision: 1,
    updatedAt: Date.now(),
  }
  writeLane(lane)
  return lane
}

/** The model-visible boundary text (rides the per-turn lane_boundary
 *  attachment — re-asserted every request, compaction-proof by construction). */
export function boundaryText(lane: ContextLane): string {
  return [
    `This session is a BOUNDED SIDE LANE (${lane.id}) branched from session ${lane.parentSessionId}.`,
    `Side goal: ${lane.goal}`,
    lane.selectedContextRefs.length > 0
      ? `Carried context: ${lane.selectedContextRefs.join(', ')}`
      : null,
    `Explicitly EXCLUDED from the parent: ${lane.excludedState.join('; ')}.`,
    `Work ONLY the side goal. File changes are real project changes; conversational state stays separate. When the goal is answered, run /branch return <one-line answer> — it records a typed handoff and flips back to the parent. Do not take over the parent's broader work.`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

/** Mint the handoff on return. changedPaths come from the CHILD's observed
 *  receipts (its main-lane ring), never from the answer prose. `owner`
 *  overrides the receipt source for fixture-owned probes (doctor deep) —
 *  live callers omit it. */
export function returnLane(args: {
  lane: ContextLane
  answer: string
  findings?: string[]
  unresolved?: string[]
  recommendedParentAction?: string
  owner?: import('../run/ownerKey.js').OwnerKey
}): ContextLane {
  const childOwner = args.owner ?? processOwnerForLane(null)
  const receipts = receiptsFor(childOwner)
  const changedPaths = [
    ...new Set(
      receipts
        .filter(r => r.effect.outcome === 'succeeded')
        .flatMap(r => r.effect.changedPaths),
    ),
  ]
  const updated: ContextLane = {
    ...args.lane,
    status: 'returned',
    handoff: {
      laneId: args.lane.id,
      answer: args.answer,
      findings: args.findings ?? [],
      changedPaths,
      refs: [`mercury://lane/${args.lane.id}`],
      unresolved: args.unresolved ?? [],
      ...(args.recommendedParentAction
        ? { recommendedParentAction: args.recommendedParentAction }
        : {}),
      returnedAt: Date.now(),
      promoted: false,
    },
    updatedAt: Date.now(),
  }
  writeLane(updated)
  return updated
}

/** Exactly-once promotion: flips the durable promoted flag; a second call
 *  answers already-promoted without re-injecting. */
export function promoteHandoff(
  laneId: string,
): { handoffText: string } | { alreadyPromoted: true } | { error: string } {
  const lane = readLane(laneId)
  if (!lane) return { error: `no lane '${laneId}'` }
  if (!lane.handoff) return { error: `lane '${laneId}' has not returned yet (status ${lane.status})` }
  if (lane.handoff.promoted) return { alreadyPromoted: true }
  const h = lane.handoff
  writeLane({
    ...lane,
    handoff: { ...h, promoted: true },
    updatedAt: Date.now(),
  })
  const text = [
    `<lane-handoff id="${lane.id}">`,
    `side goal: ${lane.goal}`,
    `answer: ${h.answer}`,
    ...(h.findings.length > 0 ? [`findings: ${h.findings.map(f => `· ${f}`).join(' ')}`] : []),
    h.changedPaths.length > 0
      ? `changed (observed in the lane): ${h.changedPaths.join(', ')}`
      : 'changed (observed in the lane): none',
    ...(h.unresolved.length > 0 ? [`unresolved: ${h.unresolved.map(u => `· ${u}`).join(' ')}`] : []),
    ...(h.recommendedParentAction ? [`recommended: ${h.recommendedParentAction}`] : []),
    `full lane: mercury://lane/${lane.id}`,
    `</lane-handoff>`,
  ].join('\n')
  return { handoffText: text }
}

export function dropLane(laneId: string): ContextLane | null {
  const lane = readLane(laneId)
  if (!lane) return null
  const updated: ContextLane = { ...lane, status: 'dropped', updatedAt: Date.now() }
  writeLane(updated)
  return updated
}

/**
 * The per-turn boundary attachment for a lane CHILD session (the
 * orchestrator's producer calls this; proofs drive it directly). Null when
 * lanes are off or the session is not an active lane child — zero cost on
 * ordinary sessions.
 */
export function laneBoundaryAttachmentFor(
  sessionId: string,
): { type: 'lane_boundary'; laneId: string; goal: string; boundary: string } | null {
  if (!lanesEnabled()) return null
  const lane = laneForChildSession(sessionId)
  if (!lane || lane.status !== 'active') return null
  return {
    type: 'lane_boundary',
    laneId: lane.id,
    goal: lane.goal,
    boundary: boundaryText(lane),
  }
}
