
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { defineStore } from '../../substrate/fileStore.js'
import { workerTranscriptPath } from './workerTranscript.js'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { retiredNowLabel } from '../../daemon/idleRetirement.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { getCwd } from '../../utils/cwd.js'
import { isEffortLevel } from '../../utils/effort.js'
import { workspaceKindOf } from '../../daemon/concourseWorktrees.js'
import { saturnSoonestFireMs } from '../../daemon/saturn.js'
import { GROUND_NOTE_MARK, stripGroundNote } from '../../daemon/isolationNote.js'
import {
  currentProject,
  inProject,
  isAuthFailureHusk,
  PARKED_CAP,
  PARKED_WEEK_MS,
  parkedSessionsOf,
  projectDisplayName,
  type ParkedSessionFact,
  type ProjectIdentity,
} from '../../utils/bootCardFacts.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import type { ConcourseElsewhereV1, ConcourseRowV1, ConcourseSnapshotV1 } from '../../components/concourse/contracts.js'
import { ELSEWHERE_CAP, elsewhereLine, projectActivity } from './projectActivity.js'
import { sessionTitleOf } from './sessionNaming.js'
import { isCrossProjectFinishedRef } from './crossProjectPings.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'
import type { ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import type { DaemonSessionRecordV1 } from '../engine-connector/daemonConnector.js'

export function concourseRecordState(
  rec: Pick<ConcourseWorkerRecordV1, 'pausedAt' | 'lastDeliveryAt' | 'lastTurnSettledAt' | 'attachedAt' | 'stoppedAt' | 'crash' | 'parkedAt' | 'bornBlankAt' | 'pid'>,
  liveness: { needsYou: boolean; alive: boolean },
): ConcourseRowV1['state'] {
  const turnSettled =
    rec.lastTurnSettledAt !== undefined &&
    (rec.lastDeliveryAt === undefined || rec.lastTurnSettledAt >= rec.lastDeliveryAt)
  const wordlessNewborn = rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined
  return rec.attachedAt !== undefined
    ? 'attached'
    : rec.parkedAt !== undefined
      ? 'parked'
      : rec.stoppedAt !== undefined
        ? 'stopped'
        : rec.pausedAt !== undefined
          ? 'paused'
          : rec.crash !== undefined
            ? 'needs-you'
            : liveness.needsYou
              ? 'needs-you'
              : liveness.alive
                ? turnSettled || wordlessNewborn
                  ? 'ready-to-review'
                  : 'working'
                : rec.pid !== undefined
                  ? 'needs-you'
                  : 'starting'
}

function entryShapeOf(entry: unknown): { type?: unknown; message?: { content?: unknown }; timestamp?: unknown } | null {
  if (!entry || typeof entry !== 'object') return null
  const env = entry as { schemaVersion?: unknown; payload?: unknown }
  if (typeof env.schemaVersion === 'number' && env.payload && typeof env.payload === 'object') {
    try {
      return recordToEntry(entry as never) as { type?: unknown; message?: { content?: unknown }; timestamp?: unknown }
    } catch {
      return null
    }
  }
  return null
}

function transcriptWindowLines(rec: { sessionId: string; workspaceId: string }, span: number, from: 'head' | 'tail'): string[] | null {
  const path = workerTranscriptPath(rec)
  if (!existsSync(path)) return null
  const size = statSync(path).size
  if (size === 0) return null
  const take = Math.min(size, span)
  const buf = Buffer.alloc(take)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, take, from === 'head' ? 0 : size - take)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8').split('\n')
}

const timestampMsOf = (raw: unknown): number | undefined => {
  if (typeof raw !== 'string') return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

export function tailActivity(rec: { sessionId: string; workspaceId: string }): { label: string; kind: 'tool' | 'text'; at?: number } | null {
  try {
    const lines = transcriptWindowLines(rec, 8192, 'tail')
    if (lines === null) return null
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i]
      if (raw === undefined || raw.length < 8) continue
      let entry: unknown
      try {
        entry = JSON.parse(raw)
      } catch {
        continue
      }
      const e = entryShapeOf(entry)
      if (e === null || e.type !== 'assistant') continue
      const content = e.message?.content
      if (!Array.isArray(content)) continue
      const at = timestampMsOf(e.timestamp)
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j] as { type?: unknown; name?: unknown; text?: unknown; input?: unknown }
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>
          const hint =
            typeof input.description === 'string'
              ? input.description
              : typeof input.file_path === 'string'
                ? basename(input.file_path)
                : typeof input.command === 'string'
                  ? input.command
                  : typeof input.pattern === 'string'
                    ? input.pattern
                    : ''
          return { label: sanitizeLabel(`${b.name}${hint.length > 0 ? ` · ${hint}` : ''}`.slice(0, 56)), kind: 'tool', ...(at !== undefined ? { at } : {}) }
        }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
          return { label: sanitizeLabel(b.text.trim().replace(/\s+/g, ' ').slice(0, 56)), kind: 'text', ...(at !== undefined ? { at } : {}) }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

export function tailActivityLabel(rec: { sessionId: string; workspaceId: string }): string | null {
  return tailActivity(rec)?.label ?? null
}

export function headBriefLabel(rec: { sessionId: string; workspaceId: string }, maxChars = 200): string | null {
  try {
    const lines = transcriptWindowLines(rec, 8192, 'head')
    if (lines === null) return null
    for (const raw of lines) {
      if (raw.length < 8) continue
      let entry: unknown
      try {
        entry = JSON.parse(raw)
      } catch {
        continue
      }
      const e = entryShapeOf(entry)
      if (e === null || e.type !== 'user') continue
      const content = e.message?.content
      const text =
        typeof content === 'string'
          ? stripGroundNote(content)
          : Array.isArray(content)
            ? content
                .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
                .filter(b => !b.text.startsWith(GROUND_NOTE_MARK))
                .map(b => b.text)
                .join(' ')
            : ''
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat.length === 0) continue
      return sanitizeLabel(flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat)
    }
    return null
  } catch {
    return null
  }
}


export interface ConcourseSeedOverridesV1 {
  projectDir?: string
  projectDirAt?: number
  modelKey?: string
  effort?: string
  isolation?: 'isolated-worktree' | 'exclusive' | 'shared-read-only'
  title?: string
  agentName?: string
  seatsMax?: 1 | 2
}

interface ConcourseDraftFileV1 {
  draft: string
  draftCaret?: number
  updatedAtMs: number
  seedOverrides?: ConcourseSeedOverridesV1
  sessionDrafts?: Record<string, string>
  sessionDraftCarets?: Record<string, number>
  heldDispatch?: {
    clientMessageId: string
    envelopeKey: string
    prompt?: string
    op?: Record<string, unknown>
  }
  heldDeliveries?: Record<string, { clientMessageId: string; text: string }>
  queuedStacks?: Record<string, Array<{ clientMessageId: string; text: string; mintedAtMs: number }>>
  pendingHandback?: { kind: 'detach' | 'valve-resume' | 'grant-workflows'; sessionId: string; mintedAtMs: number }
  coordinatorDraft?: string
  coordinatorDraftCaret?: number
  parkedCleared?: Record<string, number>
}

const PARKED_CLEARED_CAP = 256

const decodeParkedCleared = (raw: unknown): Record<string, number> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, number] => e[0].length > 0 && e[0].length <= 128 && typeof e[1] === 'number' && Number.isFinite(e[1]))
    .sort((a, b) => a[1] - b[1])
    .slice(-PARKED_CLEARED_CAP)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function clampAgentNameGraphemes(raw: string): string {
  let end = 0
  let n = 0
  for (const seg of getGraphemeSegmenter().segment(raw)) {
    if (n === 24) break
    end = seg.index + seg.segment.length
    n += 1
  }
  return raw.slice(0, end)
}

const decodeOverrides = (raw: unknown): ConcourseSeedOverridesV1 | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<ConcourseSeedOverridesV1>
  const out: ConcourseSeedOverridesV1 = {}
  if (typeof r.projectDir === 'string' && r.projectDir.length > 0) {
    const p = r.projectDir.slice(0, 1024)
    out.projectDir = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    if (typeof r.projectDirAt === 'number' && Number.isFinite(r.projectDirAt)) out.projectDirAt = r.projectDirAt
  }
  if (typeof r.modelKey === 'string' && r.modelKey.length > 0) out.modelKey = r.modelKey.slice(0, 128)
  if (typeof r.effort === 'string' && isEffortLevel(r.effort)) out.effort = r.effort
  if (typeof r.title === 'string' && r.title.length > 0) out.title = r.title.slice(0, 200)
  if (r.isolation === 'isolated-worktree' || r.isolation === 'exclusive' || r.isolation === 'shared-read-only')
    out.isolation = r.isolation
  if (typeof r.agentName === 'string' && r.agentName.length > 0) out.agentName = clampAgentNameGraphemes(r.agentName)
  if (r.seatsMax === 1 || r.seatsMax === 2) out.seatsMax = r.seatsMax
  return Object.keys(out).length > 0 ? out : undefined
}

const SESSION_DRAFT_CAP = 24

const decodeSessionDrafts = (raw: unknown): Record<string, string> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0 && k.length > 0 && k.length <= 128) out[k] = v.slice(0, 4000)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const draftStore = defineStore<ConcourseDraftFileV1, [dir?: string]>({
  name: 'concourse-draft',
  path: (dir?: string) => join(dir ?? getMercuryHome(), 'concourse-draft.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<ConcourseDraftFileV1>
    const overrides = decodeOverrides(r.seedOverrides)
    const sessionDrafts = decodeSessionDrafts(r.sessionDrafts)
    const draft = typeof r.draft === 'string' ? r.draft.slice(0, 4000) : ''
    let sessionDraftCarets: Record<string, number> | undefined
    if (sessionDrafts !== undefined && r.sessionDraftCarets && typeof r.sessionDraftCarets === 'object') {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(r.sessionDraftCarets as Record<string, unknown>)) {
        const text = sessionDrafts[k]
        if (text !== undefined && typeof v === 'number' && Number.isFinite(v)) {
          out[k] = Math.max(0, Math.min(text.length, Math.floor(v)))
        }
      }
      if (Object.keys(out).length > 0) sessionDraftCarets = out
    }
    const coordinatorDraft =
      typeof r.coordinatorDraft === 'string' && r.coordinatorDraft.length > 0
        ? r.coordinatorDraft.slice(0, 4000)
        : undefined
    const heldDispatch =
      r.heldDispatch &&
      typeof r.heldDispatch === 'object' &&
      typeof r.heldDispatch.clientMessageId === 'string' &&
      r.heldDispatch.clientMessageId.length > 0 &&
      typeof r.heldDispatch.envelopeKey === 'string'
        ? {
            clientMessageId: r.heldDispatch.clientMessageId.slice(0, 128),
            envelopeKey: r.heldDispatch.envelopeKey.slice(0, 8192),
            ...(typeof r.heldDispatch.prompt === 'string' && r.heldDispatch.prompt.length > 0
              ? { prompt: r.heldDispatch.prompt.slice(0, 8192) }
              : {}),
            ...(r.heldDispatch.op && typeof r.heldDispatch.op === 'object' && !Array.isArray(r.heldDispatch.op)
              ? { op: r.heldDispatch.op as Record<string, unknown> }
              : {}),
          }
        : undefined
    let queuedStacks: Record<string, Array<{ clientMessageId: string; text: string; mintedAtMs: number }>> | undefined
    if (r.queuedStacks && typeof r.queuedStacks === 'object' && !Array.isArray(r.queuedStacks)) {
      const out: Record<string, Array<{ clientMessageId: string; text: string; mintedAtMs: number }>> = {}
      for (const [k, v] of Object.entries(r.queuedStacks as Record<string, unknown>).slice(0, 8)) {
        if (k.length === 0 || k.length > 128 || !Array.isArray(v)) continue
        const list = (v as unknown[])
          .slice(0, 10)
          .map(e => e as { clientMessageId?: unknown; text?: unknown; mintedAtMs?: unknown })
          .filter(
            e =>
              typeof e?.clientMessageId === 'string' &&
              e.clientMessageId.length > 0 &&
              typeof e.text === 'string' &&
              e.text.length > 0,
          )
          .map(e => ({
            clientMessageId: (e.clientMessageId as string).slice(0, 160),
            text: (e.text as string).slice(0, 4000),
            mintedAtMs: typeof e.mintedAtMs === 'number' && Number.isFinite(e.mintedAtMs) ? e.mintedAtMs : 0,
          }))
        if (list.length > 0) out[k] = list
      }
      if (Object.keys(out).length > 0) queuedStacks = out
    }
    let heldDeliveries: Record<string, { clientMessageId: string; text: string }> | undefined
    if (r.heldDeliveries && typeof r.heldDeliveries === 'object' && !Array.isArray(r.heldDeliveries)) {
      const out: Record<string, { clientMessageId: string; text: string }> = {}
      for (const [k, v] of Object.entries(r.heldDeliveries as Record<string, unknown>).slice(0, SESSION_DRAFT_CAP)) {
        const h = v as { clientMessageId?: unknown; text?: unknown }
        if (
          k.length > 0 &&
          k.length <= 128 &&
          typeof h?.clientMessageId === 'string' &&
          h.clientMessageId.length > 0 &&
          typeof h.text === 'string'
        )
          out[k] = { clientMessageId: h.clientMessageId.slice(0, 128), text: h.text.slice(0, 4000) }
      }
      if (Object.keys(out).length > 0) heldDeliveries = out
    }
    return {
      draft,
      ...(typeof r.draftCaret === 'number' && Number.isFinite(r.draftCaret)
        ? { draftCaret: Math.max(0, Math.min(draft.length, Math.floor(r.draftCaret))) }
        : {}),
      updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
      ...(overrides !== undefined ? { seedOverrides: overrides } : {}),
      ...(sessionDrafts !== undefined ? { sessionDrafts } : {}),
      ...(sessionDraftCarets !== undefined ? { sessionDraftCarets } : {}),
      ...(coordinatorDraft !== undefined ? { coordinatorDraft } : {}),
      ...(coordinatorDraft !== undefined &&
      typeof r.coordinatorDraftCaret === 'number' &&
      Number.isFinite(r.coordinatorDraftCaret)
        ? { coordinatorDraftCaret: Math.max(0, Math.min(coordinatorDraft.length, Math.floor(r.coordinatorDraftCaret))) }
        : {}),
      ...(heldDispatch !== undefined ? { heldDispatch } : {}),
      ...(heldDeliveries !== undefined ? { heldDeliveries } : {}),
      ...(queuedStacks !== undefined ? { queuedStacks } : {}),
      ...(() => {
        const parkedCleared = decodeParkedCleared(r.parkedCleared)
        return parkedCleared !== undefined ? { parkedCleared } : {}
      })(),
      ...(r.pendingHandback &&
      typeof r.pendingHandback === 'object' &&
      (r.pendingHandback.kind === 'detach' ||
        r.pendingHandback.kind === 'valve-resume' ||
        r.pendingHandback.kind === 'grant-workflows') &&
      typeof r.pendingHandback.sessionId === 'string' &&
      r.pendingHandback.sessionId.length > 0
        ? {
            pendingHandback: {
              kind: r.pendingHandback.kind,
              sessionId: r.pendingHandback.sessionId.slice(0, 128),
              mintedAtMs:
                typeof r.pendingHandback.mintedAtMs === 'number' && Number.isFinite(r.pendingHandback.mintedAtMs)
                  ? r.pendingHandback.mintedAtMs
                  : 0,
            },
          }
        : {}),
    }
  },
  empty: () => ({ draft: '', updatedAtMs: 0 }),
  onReadFailure: 'empty',
})

export async function markParkedCleared(sessionId: string, dir?: string): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const map = { ...(prev.parkedCleared ?? {}) }
    delete map[sessionId]
    map[sessionId] = Date.now()
    const entries = Object.entries(map).sort((a, b) => a[1] - b[1]).slice(-PARKED_CLEARED_CAP)
    return { ...prev, updatedAtMs: Date.now(), parkedCleared: Object.fromEntries(entries) }
  })
}

export async function readParkedCleared(dir?: string): Promise<ReadonlySet<string>> {
  return new Set(Object.keys((await draftStore(dir).read()).parkedCleared ?? {}))
}

export async function writeConcourseHeldDispatch(
  held: { clientMessageId: string; envelopeKey: string; prompt?: string; op?: Record<string, unknown> } | null,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next = { ...prev, updatedAtMs: Date.now() }
    if (held === null) delete (next as { heldDispatch?: unknown }).heldDispatch
    else next.heldDispatch = held
    return next
  })
}

export async function readConcourseHeldDispatch(
  dir?: string,
): Promise<{ clientMessageId: string; envelopeKey: string; prompt?: string; op?: Record<string, unknown> } | null> {
  return (await draftStore(dir).read()).heldDispatch ?? null
}

export async function appendConcourseQueuedStackEntry(
  dispatchId: string,
  text: string,
  dir?: string,
): Promise<{ clientMessageId: string } | null> {
  let minted: { clientMessageId: string } | null = null
  await draftStore(dir).mutate(prev => {
    const stacks = { ...(prev.queuedStacks ?? {}) }
    const list = [...(stacks[dispatchId] ?? [])]
    if (list.length >= 10) return prev
    if (stacks[dispatchId] === undefined && Object.keys(stacks).length >= 8) {
      const oldest = Object.keys(stacks)[0]
      if (oldest !== undefined) delete stacks[oldest]
    }
    const clientMessageId = `${dispatchId}-stack-${Date.now().toString(36)}-${list.length}`
    minted = { clientMessageId }
    list.push({ clientMessageId, text: text.slice(0, 4000), mintedAtMs: Date.now() })
    stacks[dispatchId] = list
    return { ...prev, queuedStacks: stacks, updatedAtMs: Date.now() }
  })
  return minted
}

export async function readConcourseQueuedStack(
  dispatchId: string,
  dir?: string,
): Promise<Array<{ clientMessageId: string; text: string }>> {
  return (await draftStore(dir).read()).queuedStacks?.[dispatchId] ?? []
}

export async function writeConcoursePendingHandback(
  h: { kind: 'detach' | 'valve-resume' | 'grant-workflows'; sessionId: string; mintedAtMs: number } | null,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next = { ...prev, updatedAtMs: Date.now() }
    if (h === null) delete (next as { pendingHandback?: unknown }).pendingHandback
    else next.pendingHandback = h
    return next
  })
}

export async function readConcoursePendingHandback(
  dir?: string,
): Promise<{ kind: 'detach' | 'valve-resume' | 'grant-workflows'; sessionId: string; mintedAtMs: number } | null> {
  return (await draftStore(dir).read()).pendingHandback ?? null
}

export async function removeConcourseQueuedStackEntry(
  dispatchId: string,
  clientMessageId: string,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const stacks = { ...(prev.queuedStacks ?? {}) }
    const list = (stacks[dispatchId] ?? []).filter(e => e.clientMessageId !== clientMessageId)
    if (list.length === 0) delete stacks[dispatchId]
    else stacks[dispatchId] = list
    const next = { ...prev, updatedAtMs: Date.now() }
    if (Object.keys(stacks).length === 0) delete (next as { queuedStacks?: unknown }).queuedStacks
    else next.queuedStacks = stacks
    return next
  })
}

export async function writeConcourseHeldDelivery(
  sessionId: string,
  held: { clientMessageId: string; text: string } | null,
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const map = { ...(prev.heldDeliveries ?? {}) }
    if (held === null) delete map[sessionId]
    else {
      delete map[sessionId]
      map[sessionId] = held
      const keys = Object.keys(map)
      if (keys.length > SESSION_DRAFT_CAP) for (const k of keys.slice(0, keys.length - SESSION_DRAFT_CAP)) delete map[k]
    }
    const next = { ...prev, updatedAtMs: Date.now() }
    if (Object.keys(map).length === 0) delete (next as { heldDeliveries?: unknown }).heldDeliveries
    else next.heldDeliveries = map
    return next
  })
}

export async function readConcourseHeldDelivery(
  sessionId: string,
  dir?: string,
): Promise<{ clientMessageId: string; text: string } | null> {
  return (await draftStore(dir).read()).heldDeliveries?.[sessionId] ?? null
}

export async function readConcourseHeldDeliveries(
  dir?: string,
): Promise<Record<string, { clientMessageId: string; text: string }>> {
  return (await draftStore(dir).read()).heldDeliveries ?? {}
}

export async function readConcourseDraft(dir?: string): Promise<string> {
  return (await draftStore(dir).read()).draft
}

const PROCESS_START_MS = Date.now() - Math.floor(process.uptime() * 1000)

export function bootScopedSeedOverrides(
  seeds: ConcourseSeedOverridesV1,
  processStartMs: number = PROCESS_START_MS,
): ConcourseSeedOverridesV1 {
  if (seeds.projectDir === undefined) return seeds
  if (seeds.projectDirAt !== undefined && seeds.projectDirAt >= processStartMs) return seeds
  const { projectDir: _stale, projectDirAt: _staleAt, ...rest } = seeds
  return rest
}

export async function readConcourseSeedOverrides(dir?: string): Promise<ConcourseSeedOverridesV1> {
  return bootScopedSeedOverrides((await draftStore(dir).read()).seedOverrides ?? {})
}

export async function resolveHarnessGround(dir?: string): Promise<string> {
  try {
    const seeds = await readConcourseSeedOverrides(dir)
    if (typeof seeds.projectDir === 'string' && seeds.projectDir.length > 0) return seeds.projectDir
  } catch {
  }
  return getCwd()
}

export async function writeConcourseDraft(draft: string, dir?: string, caret?: number): Promise<void> {
  const text = draft.slice(0, 4000)
  await draftStore(dir).mutate(prev => ({
    ...prev,
    draft: text,
    draftCaret: Math.max(0, Math.min(text.length, Math.floor(caret ?? text.length))),
    updatedAtMs: Date.now(),
  }))
}

export async function writeConcourseSeedOverride(
  patch: { [K in keyof ConcourseSeedOverridesV1]?: ConcourseSeedOverridesV1[K] | null },
  dir?: string,
): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next: ConcourseSeedOverridesV1 = { ...(prev.seedOverrides ?? {}) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k as keyof ConcourseSeedOverridesV1]
      else (next as Record<string, unknown>)[k] = v
    }
    if ('projectDir' in patch) {
      if (next.projectDir !== undefined) next.projectDirAt = Date.now()
      else delete next.projectDirAt
    }
    if (
      next.isolation !== undefined &&
      next.isolation === resolveIsolationSeed({ ...next, isolation: undefined }, getCwd())
    ) {
      delete next.isolation
    }
    if (next.effort === 'high') delete next.effort
    return {
      ...prev,
      updatedAtMs: Date.now(),
      ...(Object.keys(next).length > 0 ? { seedOverrides: next } : { seedOverrides: undefined }),
    }
  })
}

export function subscribeConcourseDraft(cb: () => void, dir?: string): () => void {
  return draftStore(dir).subscribe(() => cb(), { immediate: false })
}

export function subscribeCoordinatorDraftChanges(
  cb: (change: { text: string; caret: number; cause: import('../../substrate/storeRevision.js').StoreChangeCause }) => void,
  dir?: string,
): () => void {
  return draftStore(dir).subscribeChanges(
    change => {
      const text = change.value.coordinatorDraft ?? ''
      const caret = change.value.coordinatorDraftCaret
      cb({
        text,
        caret: caret !== undefined ? Math.max(0, Math.min(text.length, caret)) : text.length,
        cause: change.cause,
      })
    },
    { immediate: false },
  )
}

export async function readConcourseSessionDraft(sessionId: string, dir?: string): Promise<string> {
  return (await draftStore(dir).read()).sessionDrafts?.[sessionId] ?? ''
}

export async function readConcourseSessionDraftState(
  sessionId: string,
  dir?: string,
): Promise<{ text: string; caret: number }> {
  const file = await draftStore(dir).read()
  const text = file.sessionDrafts?.[sessionId] ?? ''
  const caret = file.sessionDraftCarets?.[sessionId]
  return { text, caret: caret !== undefined ? Math.max(0, Math.min(text.length, caret)) : text.length }
}

export async function writeConcourseSessionDraft(sessionId: string, text: string, dir?: string, caret?: number): Promise<void> {
  await draftStore(dir).mutate(prev => {
    const next: Record<string, string> = { ...(prev.sessionDrafts ?? {}) }
    delete next[sessionId]
    if (text.length > 0) next[sessionId] = text.slice(0, 4000)
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_DRAFT_CAP))) delete next[k]
    const carets: Record<string, number> = {}
    for (const [k, v] of Object.entries(prev.sessionDraftCarets ?? {})) {
      if (next[k] !== undefined) carets[k] = v
    }
    if (next[sessionId] !== undefined && caret !== undefined && Number.isFinite(caret)) {
      carets[sessionId] = Math.max(0, Math.min(next[sessionId].length, Math.floor(caret)))
    }
    return {
      ...prev,
      updatedAtMs: Date.now(),
      ...(Object.keys(next).length > 0 ? { sessionDrafts: next } : { sessionDrafts: undefined }),
      ...(Object.keys(carets).length > 0 ? { sessionDraftCarets: carets } : { sessionDraftCarets: undefined }),
    }
  })
}

export async function readCoordinatorComposerDraft(dir?: string): Promise<{ text: string; caret: number }> {
  const file = await draftStore(dir).read()
  const text = file.coordinatorDraft ?? ''
  const caret = file.coordinatorDraftCaret
  return { text, caret: caret !== undefined ? Math.max(0, Math.min(text.length, caret)) : text.length }
}

export async function writeCoordinatorComposerDraft(text: string, caret: number, dir?: string): Promise<void> {
  const clamped = text.slice(0, 4000)
  await draftStore(dir).mutate(prev => ({
    ...prev,
    updatedAtMs: Date.now(),
    ...(clamped.length > 0
      ? {
          coordinatorDraft: clamped,
          coordinatorDraftCaret: Math.max(0, Math.min(clamped.length, Math.floor(caret))),
        }
      : { coordinatorDraft: undefined, coordinatorDraftCaret: undefined }),
  }))
}

export function resolveIsolationSeed(
  seeds: ConcourseSeedOverridesV1,
  cwd: string,
): 'isolated-worktree' | 'exclusive' | 'shared-read-only' {
  if (seeds.isolation !== undefined) return seeds.isolation
  return 'exclusive'
}

export function dispatchSeedInputs(
  seeds: ConcourseSeedOverridesV1,
  cwd: string,
  resolvedModelId?: string,
): {
  workspaceDir: string
  modelKey?: string
  effort?: string
  title?: string
  isolation: 'worktree-isolated' | 'read-only' | 'exclusive'
  agentName?: string
  seatsMax?: 1 | 2
} {
  const isolation = resolveIsolationSeed(seeds, cwd)
  return {
    workspaceDir: seeds.projectDir ?? cwd,
    ...(seeds.modelKey !== undefined
      ? { modelKey: seeds.modelKey }
      : resolvedModelId !== undefined
        ? { modelKey: resolvedModelId }
        : {}),
    ...(seeds.effort !== undefined ? { effort: seeds.effort } : {}),
    ...(seeds.title !== undefined ? { title: seeds.title } : {}),
    ...(seeds.agentName !== undefined ? { agentName: seeds.agentName } : {}),
    ...(seeds.seatsMax !== undefined ? { seatsMax: seeds.seatsMax } : {}),
    isolation:
      isolation === 'shared-read-only' ? 'read-only' : isolation === 'exclusive' ? 'exclusive' : 'worktree-isolated',
  }
}


const PARKED_SCAN_SLACK = 4

export const OLDER_CHATS_ROW_PREFIX = 'older:'

export function olderChatsRow(projectDir: string, projectLabel: string, older: number): ConcourseRowV1 {
  return {
    sessionId: `${OLDER_CHATS_ROW_PREFIX}${projectDir}`,
    title: `${older} older chat${older === 1 ? '' : 's'} · ↵ to browse`,
    state: 'parked',
    projectLabel,
    ownerLabel: null,
    ageLabel: null,
    seats: null,
    nowLabel: null,
  }
}


export interface OlderChatFact {
  sessionId: string
  transcriptPath: string
  ageMs: number
  title: string
}

export interface OlderChatsCensusV1 {
  total: number
  entries: OlderChatFact[]
}

const olderFactCache = new Map<string, { mtimeMs: number; size: number; husk: boolean; title: string | null }>()
const OLDER_FACT_CACHE_CAP = 2048

function olderFactOf(projectDir: string, file: string, mtimeMs: number, size: number): { husk: boolean; title: string | null } {
  const held = olderFactCache.get(file)
  if (held !== undefined && held.mtimeMs === mtimeMs && held.size === size) return held
  const sessionId = basename(file).replace(/\.jsonl$/, '')
  const husk = isAuthFailureHusk(file, size)
  const title = husk ? null : headBriefLabel({ sessionId, workspaceId: projectDir }, 48)
  if (olderFactCache.size >= OLDER_FACT_CACHE_CAP) olderFactCache.clear()
  const fact = { mtimeMs, size, husk, title }
  olderFactCache.set(file, fact)
  return fact
}

export function olderChatsCensus(
  projectDir: string,
  excludedSessionIds: ReadonlySet<string>,
  nowMs: number,
  opts: { excludeSessionId?: string; entryCap?: number; sessions?: readonly ParkedSessionFact[] } = {},
): OlderChatsCensusV1 {
  try {
    const entryCap = Math.max(0, opts.entryCap ?? 0)
    const skip = opts.excludeSessionId !== undefined ? `${opts.excludeSessionId}.jsonl` : null
    const candidates: Array<{ sessionId: string; file: string; mtimeMs: number; size: number; ageMs: number }> = []
    if (opts.sessions !== undefined) {
      for (const s of opts.sessions) {
        let st: { mtimeMs: number; size: number }
        try {
          st = statSync(s.transcriptPath)
        } catch {
          continue
        }
        candidates.push({ sessionId: s.sessionId, file: s.transcriptPath, mtimeMs: st.mtimeMs, size: st.size, ageMs: s.ageMs })
      }
    } else {
      const home = getProjectDir(projectDir)
      for (const f of readdirSync(home)) {
        if (!f.endsWith('.jsonl') || f === skip) continue
        try {
          const st = statSync(join(home, f))
          if (st.size === 0) continue
          candidates.push({
            sessionId: f.slice(0, -'.jsonl'.length),
            file: join(home, f),
            mtimeMs: st.mtimeMs,
            size: st.size,
            ageMs: Math.max(0, nowMs - st.mtimeMs),
          })
        } catch {
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = 0
    const entries: OlderChatFact[] = []
    for (const c of candidates) {
      if (excludedSessionIds.has(c.sessionId)) continue
      const fact = olderFactOf(projectDir, c.file, c.mtimeMs, c.size)
      if (fact.husk || fact.title === null) continue
      total += 1
      if (entries.length < entryCap) {
        entries.push({ sessionId: c.sessionId, transcriptPath: c.file, ageMs: c.ageMs, title: fact.title })
      }
    }
    return { total, entries }
  } catch {
    return { total: 0, entries: [] }
  }
}

export function parkedBoardRows(
  projectDir: string,
  liveSessionIds: ReadonlySet<string>,
  cleared: ReadonlySet<string>,
  nowMs: number,
  excludeSessionId?: string,
  sessions?: readonly ParkedSessionFact[],
): ConcourseRowV1[] {
  const rows: ConcourseRowV1[] = []
  try {
    const projectLabel = sanitizeLabel(projectDisplayName(projectDir))
    const listed =
      sessions ??
      parkedSessionsOf(projectDir, {
        ...(excludeSessionId !== undefined ? { excludeSessionId } : {}),
        cap: PARKED_CAP + liveSessionIds.size + cleared.size + PARKED_SCAN_SLACK,
        withinMs: PARKED_WEEK_MS,
        nowMs,
      })
    for (const s of listed) {
      if (rows.length >= PARKED_CAP) break
      if (liveSessionIds.has(s.sessionId) || cleared.has(s.sessionId)) continue
      const brief = headBriefLabel({ sessionId: s.sessionId, workspaceId: projectDir }, 48)
      if (brief === null) continue
      const ageLabel = ageLabelOf(nowMs, nowMs - s.ageMs)
      rows.push({
        sessionId: s.sessionId,
        title: brief,
        state: 'parked',
        projectLabel,
        ownerLabel: 'Mercury',
        ageLabel,
        seats: null,
        nowLabel: `parked · ${ageLabel}`,
        workspaceDir: projectDir,
        transcriptPath: s.transcriptPath,
      })
    }
    const excluded = new Set<string>(liveSessionIds)
    for (const r of rows) excluded.add(r.sessionId)
    const census = olderChatsCensus(projectDir, excluded, nowMs, {
      ...(excludeSessionId !== undefined ? { excludeSessionId } : {}),
      ...(sessions !== undefined ? { sessions } : {}),
    })
    if (census.total > 0) rows.push(olderChatsRow(projectDir, projectLabel, census.total))
  } catch {
  }
  return rows
}

export function sanitizeLabel(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += ch
    if (out.length >= 160) break
  }
  return out
}

export function ageLabelOf(nowMs: number, sinceMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - sinceMs) / 60_000))
  if (mins < 60) return `${String(mins).padStart(2, '0')}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function clockOf(nowMs: number): string {
  const d = new Date(nowMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function resolvedCoordinator(): Promise<{
  mode: 'off' | 'rules-only' | 'agent-assisted'
  assistModelLabel?: string
  assistModelAvailability?: import('./coordinatorModels.js').CoordinatorModelAvailability
  assistModelStatus?: string
  fallbackReason?: string
}> {
  try {
    const { resolveEffectiveCoordinator } = await import('./coordinatorLane.js')
    const effective = await resolveEffectiveCoordinator()
    const mode = effective.resolution.effective
    const fallbackReason = effective.resolution.fallbackReason
    if (effective.assistModelId !== undefined) {
      return {
        mode,
        assistModelLabel: effective.assistModelLabel ?? effective.assistModelId,
        ...(effective.assistModelStatus !== undefined && effective.assistModelAvailability !== undefined
          ? { assistModelAvailability: effective.assistModelAvailability, assistModelStatus: effective.assistModelStatus }
          : {}),
      }
    }
    if (mode !== 'off') {
      const { getGlobalConfig } = await import('../../utils/config.js')
      const cfg = getGlobalConfig().concourseCoordinator
      if (cfg?.assistModel) {
        const { validateCoordinatorModelChoice, coordinatorModelStatusLabel } = await import('./coordinatorModels.js')
        const validated = await validateCoordinatorModelChoice(cfg.assistModel)
        if (validated.ok) {
          const status = coordinatorModelStatusLabel(validated.entry)
          return {
            mode,
            assistModelLabel: validated.entry.displayName,
            ...(status.length > 0 ? { assistModelAvailability: validated.entry.availability, assistModelStatus: status } : {}),
            ...(fallbackReason !== undefined ? { fallbackReason } : {}),
          }
        }
      }
    }
    return { mode, ...(fallbackReason !== undefined ? { fallbackReason } : {}) }
  } catch {
    return { mode: 'rules-only' }
  }
}

export interface BuildConcourseSnapshotOpts {
  recordsDir?: string
  crewDir?: string
  draftDir?: string
  peekSessionId?: string
  residentOverride?: 'wink' | 'refused' | 'held'
  nowMs?: number
  project?: ProjectIdentity
}

export async function buildConcourseSnapshot(
  opts: BuildConcourseSnapshotOpts = {},
): Promise<ConcourseSnapshotV1> {
  const nowMs = opts.nowMs ?? Date.now()
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const obligations = await import('../crew/obligations.js')
  const { isProcessAlive } = await import('../../daemon/ownerWatch.js')

  const project = opts.project ?? currentProject()
  const allRecords = supervisor.listConcourseWorkers(null, opts.recordsDir)
  const records = allRecords.filter(r => inProject(project, r.workspaceId))
  await obligations
    .foldLegacyObligationsIntoSwitchboardScope(opts.crewDir)
    .catch(() => 0)
  const openObl = await obligations.openObligations({
    scope: 'switchboard',
    ...(opts.crewDir !== undefined ? { dir: opts.crewDir } : {}),
  })
  const needsYouSessions = new Set(openObl.map(o => o.sessionId))

  let focusedSessionId: string | null = null
  let focusedRecord: DaemonSessionRecordV1 | undefined
  try {
    const slot = await import('../engine-connector/focusedConnector.js')
    if (slot.hasFocusedSession()) {
      focusedSessionId = slot.getFocusedSessionConnector().sessionId()
      const seat = await import('../engine-connector/daemonConnector.js')
      focusedRecord = seat.getDaemonSessionConnector(focusedSessionId)?.record
    }
  } catch {
  }
  const foreignOf = (workspaceId: string): string | undefined =>
    inProject(project, workspaceId) ? undefined : sanitizeLabel(projectDisplayName(workspaceId))

  const aliveById = new Map<string, boolean>()
  const workspaceOfRow = new Map<string, string>()
  const allRows: ConcourseRowV1[] = allRecords.map(rec => {
    const alive = rec.pid !== undefined && isProcessAlive(rec.pid)
    aliveById.set(rec.sessionId, alive)
    const state = concourseRecordState(rec, { needsYou: needsYouSessions.has(rec.sessionId), alive })
    const projectName = basename(rec.workspaceId) || rec.workspaceId
    workspaceOfRow.set(rec.sessionId, rec.workspaceId)
    const nowLabel =
      state === 'parked'
        ? rec.parkReason !== undefined
          ? sanitizeLabel(rec.parkReason)
          : `parked · ${ageLabelOf(nowMs, rec.parkedAt ?? rec.spawnedAt)}`
        : rec.crash !== undefined && state === 'needs-you'
          ? sanitizeLabel(rec.crash.reason)
          : state === 'needs-you' && !alive && rec.pid !== undefined
            ?
              'its process is gone'
            : state === 'working' || state === 'ready-to-review' || state === 'needs-you'
              ? tailActivityLabel(rec)
            : state === 'attached'
              ? 'with you'
              : state === 'stopped' && rec.retired !== undefined
                ? retiredNowLabel(rec.retired)
                : null
    return {
      sessionId: rec.sessionId,
      title: sanitizeLabel(sessionTitleOf(rec, () => headBriefLabel(rec, 48))),
      state,
      projectLabel: sanitizeLabel(projectName),
      ownerLabel: sanitizeLabel(rec.agentName ?? 'Mercury'),
      ageLabel: ageLabelOf(nowMs, rec.spawnedAt),
      seats: null,
      nowLabel,
      ...(rec.workflowsAllowed === true ? { workflowsAllowed: true } : {}),
      ...((): { scheduleNextFireMs?: number } => {
        const next = saturnSoonestFireMs(rec, nowMs)
        return next !== null ? { scheduleNextFireMs: next } : {}
      })(),
      workspaceDir: rec.workspaceId,
      ...(typeof rec.modelKey === 'string' && rec.modelKey !== '' ? { modelId: rec.modelKey } : {}),
      ...(rec.branchName !== undefined ? { worktreeBranch: sanitizeLabel(rec.branchName) } : {}),
      ...(state === 'parked' ? { transcriptPath: workerTranscriptPath(rec) } : {}),
    }
  })

  try {
    const { readConcourseDispatches, normalizeHoldReason } = await import('../../daemon/concourseDispatch.js')
    const heldRows = Object.values(readConcourseDispatches(opts.recordsDir))
      .filter(d => d.state === 'queued' && d.sessionId === undefined && d.heldReason !== undefined)
      .filter(d => d.workspaceId === undefined || inProject(project, d.workspaceId))
      .map(d => {
        let waitReason: ConcourseRowV1['waitReason'] = normalizeHoldReason(d.heldReason) as Exclude<
          ReturnType<typeof normalizeHoldReason>,
          'session-with-you'
        >
        if (waitReason === 'repo-held') {
          const holderLive = allRecords.some(
            r =>
              r.endedAt === undefined &&
              r.workspaceId === d.workspaceId &&
              (r.isolation ?? 'exclusive') === 'exclusive' &&
              ((r.pid !== undefined && isProcessAlive(r.pid)) || r.attachedAt !== undefined),
          )
          if (!holderLive) waitReason = 'unblocked'
        }
        if (d.workspaceId !== undefined) workspaceOfRow.set(`dispatch:${d.clientMessageId}`, d.workspaceId)
        return {
          sessionId: `dispatch:${d.clientMessageId}`,
          title: sanitizeLabel(d.title ?? 'queued dispatch'),
          state: 'queued' as const,
          projectLabel: sanitizeLabel(d.workspaceId !== undefined ? basename(d.workspaceId) || d.workspaceId : '—'),
          ownerLabel: '—',
          ageLabel: ageLabelOf(nowMs, d.acceptedAt),
          seats: null,
          ...(waitReason !== undefined ? { waitReason } : {}),
          ...(waitReason !== 'unblocked' && d.heldByTitle !== undefined
            ? { waitDetail: sanitizeLabel(d.heldByTitle) }
            : {}),
        }
      })
    allRows.push(...heldRows)
  } catch {
  }

  try {
    const { readCollisionEvidence } = await import('../../daemon/concourseSupervisor.js')
    const retainedRows = readCollisionEvidence(opts.recordsDir)
      .filter(e => e.kind === 'authored-work-retained' && e.consumedAt === undefined && e.branchName !== undefined)
      .filter(e => inProject(project, e.workspaceId))
      .slice(-6)
      .map(e => ({
        sessionId: e.holders[0]?.sessionId ?? `retained:${e.holders[0]?.workerId ?? e.observedAt}`,
        title: sanitizeLabel(e.branchName ?? 'finished fork'),
        state: 'ready-to-review' as const,
        projectLabel: sanitizeLabel(basename(e.workspaceId) || e.workspaceId),
        ownerLabel: '—',
        ageLabel: ageLabelOf(nowMs, e.observedAt),
        seats: null,
        nowLabel: 'ready to merge',
        workspaceDir: e.workspaceId,
        worktreeBranch: sanitizeLabel(e.branchName ?? ''),
      }))
    for (const r of retainedRows) {
      if (!allRows.some(x => x.sessionId === r.sessionId)) allRows.push(r)
    }
  } catch {
  }

  const rows = allRows.flatMap(r => {
    const workspace = workspaceOfRow.get(r.sessionId)
    if (workspace === undefined || inProject(project, workspace)) return [r]
    return r.sessionId === focusedSessionId ? [{ ...r, foreignProject: foreignOf(workspace) ?? '' }] : []
  })
  let foreignParkedRow: ConcourseRowV1 | undefined
  if (
    focusedSessionId !== null &&
    focusedRecord !== undefined &&
    !rows.some(r => r.sessionId === focusedSessionId) &&
    foreignOf(focusedRecord.workspaceId) !== undefined
  ) {
    const name = foreignOf(focusedRecord.workspaceId) ?? ''
    foreignParkedRow = {
      sessionId: focusedSessionId,
      title: sanitizeLabel(focusedRecord.title.length > 0 ? focusedRecord.title : focusedSessionId.slice(0, 8)),
      state: 'parked',
      projectLabel: name,
      ownerLabel: 'Mercury',
      ageLabel: null,
      seats: null,
      nowLabel: 'parked',
      workspaceDir: focusedRecord.workspaceId,
      transcriptPath: join(focusedRecord.home, `${focusedSessionId}.jsonl`),
      foreignProject: name,
    }
  }

  const byBucket = (bucket: ConcourseRowV1['state'][]): ConcourseRowV1[] =>
    rows.filter(r => bucket.includes(r.state))
  const groups: ConcourseSnapshotV1['groups'] = []
  const attachedRows = byBucket(['attached'])
  if (attachedRows.length > 0) groups.push({ id: 'attached', label: 'WITH YOU', rows: attachedRows })
  const needsYouRows = byBucket(['needs-you'])
  const reviewRows = byBucket(['ready-to-review'])
  const workingRows = byBucket(['working'])
  const startingRows = byBucket(['starting'])
  const queuedRows = byBucket(['queued'])
  const pausedRows = byBucket(['paused'])
  const stoppedRows = byBucket(['stopped'])
  if (needsYouRows.length > 0) groups.push({ id: 'needs-you', label: 'NEEDS YOU', rows: needsYouRows })
  if (reviewRows.length > 0) groups.push({ id: 'ready-to-review', label: 'READY TO REVIEW', rows: reviewRows })
  if (workingRows.length > 0) groups.push({ id: 'working', label: 'WORKING', rows: workingRows })
  if (startingRows.length > 0) groups.push({ id: 'starting', label: 'STARTING', rows: startingRows })
  if (queuedRows.length > 0) groups.push({ id: 'queued', label: 'QUEUED', rows: queuedRows })
  if (pausedRows.length > 0) groups.push({ id: 'paused', label: 'PAUSED', rows: pausedRows })
  if (stoppedRows.length > 0) groups.push({ id: 'stopped', label: 'STOPPED', rows: stoppedRows })
  const elsewhere: ConcourseElsewhereV1[] = projectActivity(allRows, {
    current: project,
    excludeSessionId: focusedSessionId,
    aliveOf: sessionId => aliveById.get(sessionId) ?? false,
  })
  const shownElsewhere = elsewhere.slice(0, ELSEWHERE_CAP).sort((a, b) => a.name.localeCompare(b.name))
  const doorRows: ConcourseRowV1[] = shownElsewhere.map(p => ({
    sessionId: `project:${p.key}`,
    title: sanitizeLabel(elsewhereLine(p)),
    state: 'elsewhere',
    projectLabel: sanitizeLabel(p.name),
    ownerLabel: null,
    ageLabel: null,
    seats: null,
    nowLabel: 'switch to see them',
    door: { kind: 'switch-project', dir: p.dir, running: p.running, needsYou: p.needsYou, finished: p.finished },
  }))
  const moreElsewhere = elsewhere.length - shownElsewhere.length
  if (moreElsewhere > 0) {
    doorRows.push({
      sessionId: 'project:+more',
      title: `+${moreElsewhere} more project${moreElsewhere === 1 ? '' : 's'} with activity`,
      state: 'elsewhere',
      projectLabel: '—',
      ownerLabel: null,
      ageLabel: null,
      seats: null,
      nowLabel: keyHintLabel('⌃g picks one'),
      door: { kind: 'pick-project', more: moreElsewhere },
    })
  }
  if (doorRows.length > 0) groups.push({ id: 'elsewhere', label: 'OTHER PROJECTS', rows: doorRows })
  rows.push(...doorRows)

  const LIVE_STATES: ReadonlyArray<ConcourseRowV1['state']> = ['working', 'needs-you', 'stalled', 'paused', 'ready-to-review', 'attached', 'starting']
  const holdsSeat = (r: ConcourseRowV1): boolean =>
    LIVE_STATES.includes(r.state) &&
    (r.state === 'attached' || r.state === 'starting' || aliveById.get(r.sessionId) === true)
  const live = rows.filter(holdsSeat)
  const liveAll = allRows.filter(holdsSeat)
  const peekRecord =
    records.find(r => r.sessionId === (opts.peekSessionId ?? '')) ??
    records.find(r => live.some(l => l.sessionId === r.sessionId)) ??
    null

  const scopeClear =
    peekRecord === null ||
    !allRecords.some(
      other =>
        other !== peekRecord &&
        other.workspaceId === peekRecord.workspaceId &&
        (other.isolation ?? 'exclusive') === 'exclusive' &&
        (peekRecord.isolation ?? 'exclusive') === 'exclusive',
    )

  const draftFile = await draftStore(opts.draftDir).read()
  const draft = draftFile.draft
  const draftCaret = Math.max(0, Math.min(draft.length, draftFile.draftCaret ?? draft.length))
  const seedOverrides = await readConcourseSeedOverrides(opts.draftDir)
  const projectLabel = project.name
  let hostSessionId: string | undefined
  try {
    const state = await import('../../bootstrap/state.js')
    hostSessionId = String(state.getSessionId())
  } catch {
    hostSessionId = undefined
  }
  const parkedRecordRows = byBucket(['parked']).sort((a, b) => {
    const at = (row: ConcourseRowV1): number => records.find(r => r.sessionId === row.sessionId)?.parkedAt ?? 0
    return at(b) - at(a)
  })
  const parkedTranscriptRows = parkedBoardRows(
    project.dir,
    new Set(allRecords.map(r => r.sessionId)),
    new Set(Object.keys(draftFile.parkedCleared ?? {})),
    nowMs,
    hostSessionId,
  )
  const parkedRows = [...parkedRecordRows, ...parkedTranscriptRows]
  const parkedGroupRows = [...(foreignParkedRow !== undefined ? [foreignParkedRow] : []), ...parkedRows]
  if (parkedGroupRows.length > 0) groups.push({ id: 'parked', label: 'PARKED', rows: parkedGroupRows })
  rows.push(...parkedTranscriptRows)
  if (foreignParkedRow !== undefined) rows.push(foreignParkedRow)
  const { composeWorkerModelRegistry, canonicalWorkerModelId, defaultWorkerModelId } = await import('./workerModels.js')
  const workerRegistry = await composeWorkerModelRegistry()
  const chosenModelId =
    seedOverrides.modelKey !== undefined
      ? await canonicalWorkerModelId(seedOverrides.modelKey)
      : defaultWorkerModelId(workerRegistry, 'session')
  const modelLabel =
    workerRegistry.entries.find(e => e.modelId === chosenModelId)?.displayName ?? chosenModelId
  let scopeDetail = 'shares a workspace exclusively'
  if (!scopeClear && peekRecord !== null) {
    try {
      const evidence = supervisor
        .readCollisionEvidence(opts.recordsDir)
        .filter(e => e.workspaceId === peekRecord.workspaceId && e.kind === 'exclusive-overlap')
      const latest = evidence[evidence.length - 1]
      if (latest !== undefined) {
        scopeDetail = `exclusive overlap · ${latest.holders.length} holder(s) · ${clockOf(latest.observedAt)}`
      }
    } catch {
    }
  }
  let preflight: { ok: boolean; refusals: string[] } | undefined
  if (draft.length > 0) {
    try {
      const { preflightConcourseDispatch } = await import('../../daemon/concourseDispatch.js')
      const previewReq: Omit<ReturnType<typeof dispatchSeedInputs>, 'isolation'> & {
        isolation?: 'worktree-isolated' | 'read-only' | 'exclusive'
      } = { ...dispatchSeedInputs(seedOverrides, getCwd()) }
      if (seedOverrides.isolation === undefined) delete previewReq.isolation
      const pf = await preflightConcourseDispatch(previewReq, opts.recordsDir)
      preflight = pf.ok ? { ok: true, refusals: [] } : { ok: false, refusals: pf.refusals.map(r => r.reason).slice(0, 3) }
    } catch {
      preflight = undefined
    }
  }
  const coordinator = await resolvedCoordinator()
  // global lane joins the denominator); its held permit joins the numerator
  let coordinatorHeld = 0
  if (coordinator.mode === 'agent-assisted') {
    try {
      const governor = await import('../capacity/governor.js')
      coordinatorHeld = governor.heldPermits().filter(g => g.lane === 'coordinator').length
    } catch {
      coordinatorHeld = 0
    }
  }

  const railModelId =
    peekRecord !== null ? await canonicalWorkerModelId(peekRecord.modelKey ?? 'fable') : chosenModelId
  const railEffort =
    (peekRecord !== null ? peekRecord.effort : seedOverrides.effort) ??
    workerRegistry.entries.find(e => e.modelId === railModelId)?.effort
  return {
    schema: 1,
    revision: nowMs,
    clock: clockOf(nowMs),
    context: {
      projectLabel,
      operatorHandle: (await import('../../utils/cockpit/presenceLive.js')).getOperatorName(),
      ...(railEffort ? { effortLabel: railEffort } : {}),
    },
    breadcrumb: { active: 'concourse' },
    coordinator,
    mainRepl: {
      kind: 'non-model-controller',
      counted: false,
      submission: 'disabled-while-parked',
      reachedBy: 'esc',
    },
    counts: {
      live: liveAll.length,
      needsYou: openObl.length,
      working: allRows.filter(r => r.state === 'working').length,
      queued: allRows.filter(r => r.state === 'starting').length,
      seatsHeld: coordinatorHeld,
      seatsDenominator:
        liveAll.reduce((sum, row) => {
          const rec = allRecords.find(r => r.sessionId === row.sessionId)
          return sum + (rec?.seatsMax ?? 2)
        }, 0) + (coordinator.mode === 'agent-assisted' ? 1 : 0),
      admission: 'auto-balanced',
    },
    needsYou: openObl.map(o => {
      const rec = allRecords.find(r => r.sessionId === o.sessionId)
      const home = rec !== undefined ? foreignOf(rec.workspaceId) : undefined
      const finished = isCrossProjectFinishedRef(o.ref)
      return {
        obligationId: o.obligationId,
        ...(o.ref !== undefined ? { ref: o.ref } : {}),
        sessionId: o.sessionId,
        title:
          home !== undefined
            ? sanitizeLabel(`switch to ${home} · ${finished ? 'finished' : 'needs you'}`)
            : sanitizeLabel(o.question.length > 24 ? `${o.question.slice(0, 24)}…` : o.question),
        question: sanitizeLabel(o.question),
        projectLabel: rec !== undefined ? sanitizeLabel(projectDisplayName(rec.workspaceId)) : projectLabel,
        agentLabel: sanitizeLabel(o.owner),
        ageLabel: ageLabelOf(nowMs, o.createdAtMs),
        ...(home !== undefined && rec !== undefined ? { foreignProject: { dir: rec.workspaceId, name: home } } : {}),
      }
    }),
    groups,
    elsewhere,
    peek: peekRecord
      ? {
          sessionId: peekRecord.sessionId,
          title: sanitizeLabel(sessionTitleOf(peekRecord, () => headBriefLabel(peekRecord, 48))),
          state: concourseRecordState(peekRecord, {
            needsYou: needsYouSessions.has(peekRecord.sessionId),
            alive: peekRecord.pid !== undefined && isProcessAlive(peekRecord.pid),
          }),
          projectLabel: sanitizeLabel(
            (basename(peekRecord.workspaceId) || peekRecord.workspaceId) +
              (peekRecord.workspaceKind === 'plain-folder' ? ' · plain folder' : ''),
          ),
          agentLabel: sanitizeLabel(peekRecord.agentName ?? 'Mercury'),
          modelLabel:
            workerRegistry.entries.find(e => e.modelId === railModelId)?.displayName ?? peekRecord.modelKey,
          ...(await (async () => {
            const cap = peekRecord.settingsSnapshot
            if (cap === undefined) return {}
            try {
              const { readBootDefaultsProfile } = await import('../../substrate/startupMenu.js')
              const nowRev = readBootDefaultsProfile()?.revision ?? 0
              return {
                settings: {
                  revisionLabel: `r${cap.profileRevision}`,
                  profileRevision: cap.profileRevision,
                  current: cap.profileRevision === nowRev,
                },
              }
            } catch {
              return {}
            }
          })()),
          seats: null,
          timeline: [{ clock: clockOf(peekRecord.spawnedAt), label: 'started' }],
          scope: scopeClear ? { kind: 'clear' } : { kind: 'overlap', detail: scopeDetail },
          actions: [
            'enter-full-session',
            ...(peekRecord.pausedAt === undefined && peekRecord.pid !== undefined && isProcessAlive(peekRecord.pid)
              ? (['pause-after-turn', 'redirect'] as const)
              : []),
            ...(peekRecord.pausedAt !== undefined ? (['resume'] as const) : []),
          ],
          residentState:
            opts.residentOverride ??
            (rows.find(r => r.sessionId === peekRecord.sessionId)?.state === 'starting' ? 'molt' : 'settled'),
        }
      : null,
    newSession: {
      seeds: {
        projectLabel,
        agentLabel: sanitizeLabel(seedOverrides.agentName ?? 'Mercury'),
        modelLabel,
        modelId: chosenModelId,
        modelIsDefault: chosenModelId === defaultWorkerModelId(workerRegistry, 'session'),
        effortLevel: seedOverrides.effort ?? 'high',
        effortIsDefault: (seedOverrides.effort ?? 'high') === 'high',
        isolation: resolveIsolationSeed(seedOverrides, getCwd()),
        seatsMax: seedOverrides.seatsMax ?? 2,
      },
      draft,
      draftCaret,
      modelOptions: workerRegistry.entries
        .filter(e => e.session.availability === 'available')
        .map(e => ({ modelId: e.modelId, displayName: e.displayName })),
      advancedAvailable: true,
      ...(seedOverrides.title !== undefined ? { titleSeed: seedOverrides.title } : {}),
      ...(preflight !== undefined ? { preflight } : {}),
    },
  }
}
