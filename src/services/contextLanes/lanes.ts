
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
  excludedState: string[]
  createdAt: number
  status: 'active' | 'returned' | 'dropped'
  boundaryRevision: number
  handoff?: HandoffEnvelope
  updatedAt: number
}


function lanesDir(): string {
  return path.join(getMercuryHome(), 'lanes')
}

function lanePath(id: string): string {
  return path.join(lanesDir(), `${id}.json`)
}

function writeLane(lane: ContextLane): void {
  mkdirSync(lanesDir(), { recursive: true })
  durableAtomicPublishSync(lanePath(lane.id), JSON.stringify(lane, null, 2))
  laneScanMemo = null
}

let laneScanMemo: { dirMtimeMs: number; byChild: Map<string, ContextLane | null> } | null = null

function lanesDirMtimeMs(): number {
  try {
    return statSync(lanesDir()).mtimeMs
  } catch {
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

export function listLanes(filter?: {
  parentSessionId?: string
  childSessionId?: string
}): ContextLane[] {
  return valueOr(listLanesSource(filter), [])
}

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
