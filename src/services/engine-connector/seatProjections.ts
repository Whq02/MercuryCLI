import type { FoldStatusV1 } from '../compact/foldStatus.js'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonDir } from '../../daemon/controlSocket.js'
import { publishAtomic } from '../../substrate/fileStore.js'
import type { PermissionMode, PermissionUpdate } from '../../types/permissions.js'
import type { EffortResolution } from '../../utils/effort.js'
import type { RequestWaitV1 } from '../providers/streamIdleBudget.js'
import type { TextPhase } from '../../types/wire.js'
import type { DecisionReasonWireV1 } from '../../utils/permissions/decisionReasonWire.js'
import type { PromptInputMode, QueuePriority } from '../../types/textInputTypes.js'
import type {
  McpRosterEntryV1,
  MissionRowV1,
  SampleRowV1,
  SeatIdentityV1,
  SkillsRosterEntryV1,
  UsageFactsV1,
  WorkRowV1,
  WorkspaceFactsV1,
} from './types.js'


export interface QueuedFactV1 {
  uuid?: string
  value: string
  mode: PromptInputMode
  priority?: QueuePriority
}

export interface SessionFactsAnswerV1 {
  model: {
    effective: string
    setting: string | null
  }
  usage: UsageFactsV1
  identity: SeatIdentityV1
  skills: SkillsRosterEntryV1[]
  mcp: McpRosterEntryV1[]
  permissionMode: PermissionMode
  effortSent?: string | null
  workspace: WorkspaceFactsV1
  queue: QueuedFactV1[]
  work?: WorkRowV1[]
  mission?: MissionRowV1[]
  samples?: SampleRowV1[]
  kit?: import('../../daemon/sessionKit.js').SessionKitV1
  pendingScheduleEdits?: import('../../daemon/saturn.js').ScheduleOpRequestV1[]
  fileCheckpoints?: FileCheckpointFactsV1
  streamIdleTimeoutMs?: number
  spawnSwitches?: import('../switchboard/spawnSwitches.js').SpawnSwitchFacts
}

export interface FileCheckpointFactsV1 {
  capture: boolean
  restorable: string[]
}

export interface SessionFactsV1 extends Omit<SessionFactsAnswerV1, 'permissionMode'> {
  schema: 1
  sessionId: string
  atMs: number
  permissionMode?: PermissionMode
  pendingModel: string | null
  effort?: string
  pendingSpawnSwitches?: Array<{ kind: 'subagents' | 'workflows'; on: boolean }>
  modelSettled?: { from: string; to: string; atMs: number }
  busy: boolean
  turnStartedAt?: number
  schedules?: import('../../daemon/saturn.js').SaturnFactsRowV1[]
  heldFireCount?: number
}


export interface SessionAskProjectionV1 {
  requestId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  decisionReasonDetail?: DecisionReasonWireV1
  description?: string
  askedAt: number
}

export interface SessionAsksV1 {
  schema: 1
  sessionId: string
  asks: SessionAskProjectionV1[]
}

export interface SessionTailV1 {
  schema: 1
  sessionId: string
  atMs: number
  text: string | null
  turnChars?: number
  messageId?: string
  phase?: TextPhase
  stateWord?: 'compacting' | 'waiting-on-agents'
  waitingOnAgents?: number
  fold?: FoldStatusV1
  wait?: RequestWaitV1
  lastEventAtMs?: number
  streamBlock?: 'thinking' | 'text' | 'tool_use'
  blockSinceMs?: number
}

export interface SessionProgressEntryV1 {
  toolUseID: string
  dataType: string
  seq: number
  latestLine?: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  mcpProgress?: number
  mcpTotal?: number
  budgetMs?: number
}

export interface SessionProgressV1 {
  schema: 1
  sessionId: string
  atMs: number
  tools: Record<string, SessionProgressEntryV1>
}


function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function sessionFactsDir(dir: string = daemonDir()): string {
  return join(dir, 'session-facts')
}

export function sessionAsksDir(dir: string = daemonDir()): string {
  return join(dir, 'session-asks')
}

export function sessionFactsPath(sessionId: string, dir?: string): string {
  return join(sessionFactsDir(dir), `${safeName(sessionId)}.json`)
}

export function sessionAsksPath(sessionId: string, dir?: string): string {
  return join(sessionAsksDir(dir), `${safeName(sessionId)}.json`)
}

export function sessionTailDir(dir: string = daemonDir()): string {
  return join(dir, 'session-tail')
}

export function sessionTailPath(sessionId: string, dir?: string): string {
  return join(sessionTailDir(dir), `${safeName(sessionId)}.json`)
}

export function sessionProgressDir(dir: string = daemonDir()): string {
  return join(dir, 'session-progress')
}

export function sessionProgressPath(sessionId: string, dir?: string): string {
  return join(sessionProgressDir(dir), `${safeName(sessionId)}.json`)
}


function readJson<T>(path: string, accept: (raw: unknown) => raw is T): T | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return accept(raw) ? raw : null
  } catch {
    return null
  }
}

function isFacts(raw: unknown): raw is SessionFactsV1 {
  const r = raw as Partial<SessionFactsV1> | null
  return (
    !!r &&
    typeof r === 'object' &&
    r.schema === 1 &&
    typeof r.sessionId === 'string' &&
    !!r.model &&
    typeof r.model.effective === 'string' &&
    !!r.usage &&
    Array.isArray(r.queue)
  )
}

function isAsks(raw: unknown): raw is SessionAsksV1 {
  const r = raw as Partial<SessionAsksV1> | null
  return !!r && typeof r === 'object' && r.schema === 1 && typeof r.sessionId === 'string' && Array.isArray(r.asks)
}

export function readSessionFacts(sessionId: string, dir?: string): SessionFactsV1 | null {
  return readJson(sessionFactsPath(sessionId, dir), isFacts)
}

export function readSessionAsks(sessionId: string, dir?: string): SessionAsksV1 | null {
  return readJson(sessionAsksPath(sessionId, dir), isAsks)
}

function isTail(raw: unknown): raw is SessionTailV1 {
  const r = raw as Partial<SessionTailV1> | null
  return !!r && typeof r === 'object' && r.schema === 1 && typeof r.sessionId === 'string' && typeof r.atMs === 'number' && (r.text === null || typeof r.text === 'string')
}

export function readSessionTail(sessionId: string, dir?: string): SessionTailV1 | null {
  return readJson(sessionTailPath(sessionId, dir), isTail)
}

function isProgress(raw: unknown): raw is SessionProgressV1 {
  const r = raw as Partial<SessionProgressV1> | null
  return (
    !!r &&
    typeof r === 'object' &&
    r.schema === 1 &&
    typeof r.sessionId === 'string' &&
    typeof r.atMs === 'number' &&
    !!r.tools &&
    typeof r.tools === 'object' &&
    !Array.isArray(r.tools)
  )
}

export function readSessionProgress(sessionId: string, dir?: string): SessionProgressV1 | null {
  return readJson(sessionProgressPath(sessionId, dir), isProgress)
}


const publishChains = new Map<string, Promise<void>>()
function publishOrdered(path: string, bytes: string): void {
  const prev = publishChains.get(path) ?? Promise.resolve()
  const next = prev.then(() => publishAtomic(path, bytes)).catch(() => {})
  publishChains.set(path, next)
  void next.then(() => {
    if (publishChains.get(path) === next) publishChains.delete(path)
  })
}

export function publishSessionFacts(facts: SessionFactsV1, dir?: string): void {
  mkdirSync(sessionFactsDir(dir), { recursive: true })
  publishOrdered(sessionFactsPath(facts.sessionId, dir), `${JSON.stringify(facts)}\n`)
}

export function publishSessionAsks(asks: SessionAsksV1, dir?: string): void {
  mkdirSync(sessionAsksDir(dir), { recursive: true })
  publishOrdered(sessionAsksPath(asks.sessionId, dir), `${JSON.stringify(asks)}\n`)
}

export function publishSessionTail(tail: SessionTailV1, dir?: string): void {
  const dest = sessionTailPath(tail.sessionId, dir)
  mkdirSync(sessionTailDir(dir), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(tail)}\n`)
  renameSync(tmp, dest)
}

export function publishSessionProgress(progress: SessionProgressV1, dir?: string): void {
  const dest = sessionProgressPath(progress.sessionId, dir)
  mkdirSync(sessionProgressDir(dir), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(progress)}\n`)
  renameSync(tmp, dest)
}

export function resetSeatProjections(dir?: string): void {
  for (const d of [sessionFactsDir(dir), sessionAsksDir(dir), sessionTailDir(dir), sessionProgressDir(dir)]) {
    try {
      for (const f of readdirSync(d)) rmSync(join(d, f), { force: true })
    } catch {
    }
  }
}

export function retireSeatProjections(sessionId: string, dir?: string): void {
  for (const p of [sessionFactsPath(sessionId, dir), sessionAsksPath(sessionId, dir), sessionTailPath(sessionId, dir), sessionProgressPath(sessionId, dir)]) {
    rmSync(p, { force: true })
  }
}

export function effortSentOf(truth: Pick<EffortResolution, 'supportsEffort' | 'wire' | 'catalogue'>): string | null | undefined {
  if (!truth.supportsEffort) return null
  if (truth.catalogue === 'gpt-unstated') return undefined
  return truth.wire ?? null
}
