
import { randomBytes } from 'node:crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'
import { getMercuryHome } from '../envUtils.js'
import {
  classifyReadFailure,
  sourceEmpty,
  sourceReady,
  valueOr,
  type SourceState,
} from '../../substrate/sourceState.js'
import { relocateAnchor, validateAnchor } from './anchors.js'
import {
  canTransitionStatus,
  foldScopeDecisions,
  type ReviewActorRef,
  type ReviewAnchor,
  type ReviewArtifactBody,
  type ReviewArtifactHead,
  type ReviewArtifactKind,
  type ReviewArtifactProducer,
  type ReviewArtifactState,
  type ReviewArtifactStatus,
  type ReviewArtifactVersion,
  type ReviewArtifactWorkspace,
  type ReviewComment,
  type ReviewJournalEvent,
  type ReviewScope,
  type ReviewScopeDecisionKind,
  type ScopeDecisionFold,
} from './reviewContracts.js'

const BODY_MAX_BYTES = 512 * 1024

export function reviewArtifactsRoot(): string {
  const override = flagEnv('MERCURY_REVIEW_ARTIFACTS_DIR')
  if (override && override.trim() !== '') return override
  return path.join(getMercuryHome(), 'review-artifacts')
}

const ID_RE = /^ra-[0-9a-f]{8}$/

function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function sameRootIdentity(a: string | undefined, b: string): boolean {
  if (!a) return false
  return realpathSafe(a) === realpathSafe(b)
}

export function isReviewArtifactId(id: string): boolean {
  return ID_RE.test(id)
}

function journalPath(id: string): string {
  return path.join(reviewArtifactsRoot(), id, 'journal.jsonl')
}

export function reviewArtifactJournalExists(id: string): boolean {
  try {
    return isReviewArtifactId(id) && existsSync(journalPath(id))
  } catch {
    return false
  }
}


const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function artifactLockOwnedBy(lock: string, token: string): boolean {
  try {
    return readFileSync(path.join(lock, 'owner'), 'utf8') === token
  } catch {
    return true
  }
}

function withArtifactLock<T>(id: string, fn: () => T): T {
  const dir = path.join(reviewArtifactsRoot(), id)
  mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, '.write-lock')
  const token = `${process.pid}:${randomBytes(6).toString('hex')}`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      try {
        writeFileSync(path.join(lock, 'owner'), token, 'utf8')
      } catch {
      }
      break
    } catch {
      try {
        const age = Date.now() - statSync(lock).mtimeMs
        if (age > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`the artifact '${id}' write lock is held (waited ${LOCK_TIMEOUT_MS}ms)`)
      }
      sleepSync(15)
    }
  }
  try {
    return fn()
  } finally {
    if (artifactLockOwnedBy(lock, token)) {
      try {
        rmSync(lock, { recursive: true, force: true })
      } catch {
      }
    }
  }
}

function fencedWrite<T>(id: string, fn: () => ReviewWriteResult<T>): ReviewWriteResult<T> {
  try {
    return withArtifactLock(id, fn)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `write failed: ${msg.slice(0, 200)}` }
  }
}


function appendEvents(id: string, events: ReviewJournalEvent[]): void {
  const dir = path.join(reviewArtifactsRoot(), id)
  mkdirSync(dir, { recursive: true })
  const file = journalPath(id)
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  let needsLeadingNewline = false
  try {
    const size = statSync(file).size
    if (size > 0) {
      const fd = readFileSync(file)
      needsLeadingNewline = fd.length > 0 && fd[fd.length - 1] !== 0x0a
    }
  } catch {
    needsLeadingNewline = false
  }
  appendFileSync(file, (needsLeadingNewline ? '\n' : '') + lines, 'utf8')
}


function decodeEvent(line: string): ReviewJournalEvent | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    if (raw === null || typeof raw !== 'object' || raw.v !== 1) return null
    if (typeof raw.type !== 'string' || typeof raw.at !== 'number') return null
    return raw as unknown as ReviewJournalEvent
  } catch {
    return null
  }
}

function foldJournal(id: string, raw: string): ReviewArtifactState | null {
  const state: ReviewArtifactState = {
    id,
    kind: 'plan',
    title: '',
    versions: [],
    statuses: {},
    comments: [],
    scopeDecisions: [],
    latestVersion: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  let sawVersion = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const ev = decodeEvent(line)
    if (!ev) continue
    state.updatedAt = Math.max(state.updatedAt, ev.at)
    switch (ev.type) {
      case 'version': {
        const rec = ev.record
        if (rec?.schema !== 1 || rec.id !== id) continue
        if (rec.version !== state.latestVersion + 1) continue
        state.versions.push(rec)
        state.latestVersion = rec.version
        state.kind = rec.kind
        state.title = rec.title
        if (!sawVersion) {
          state.createdAt = rec.createdAt
          sawVersion = true
        }
        break
      }
      case 'status': {
        if (ev.version < 1 || ev.version > state.latestVersion) continue
        state.statuses[ev.version] = ev.status
        break
      }
      case 'comment': {
        const c = ev.comment
        if (!c || typeof c.id !== 'string') continue
        if (typeof c.version !== 'number' || c.version < 1 || c.version > state.latestVersion) continue
        if (state.comments.some(x => x.id === c.id)) continue
        const parentOk =
          c.parentCommentId !== undefined && state.comments.some(x => x.id === c.parentCommentId)
        state.comments.push({
          id: c.id,
          artifactId: id,
          version: c.version,
          anchor: c.anchor,
          author: c.author,
          ...(c.authorRef !== undefined ? { authorRef: c.authorRef } : {}),
          ...(parentOk ? { parentCommentId: c.parentCommentId } : {}),
          body: c.body,
          state: 'open',
          createdAt: ev.at,
          updatedAt: ev.at,
        })
        break
      }
      case 'scope-decision': {
        if (typeof ev.version !== 'number' || ev.version < 1 || ev.version > state.latestVersion) continue
        if (ev.decision !== 'accept' && ev.decision !== 'request-revision') continue
        state.scopeDecisions.push({
          version: ev.version,
          scope: ev.scope,
          decision: ev.decision,
          ...(ev.by !== undefined ? { by: ev.by } : {}),
          ...(ev.authorRef !== undefined ? { authorRef: ev.authorRef } : {}),
          at: ev.at,
        })
        break
      }
      case 'comment-state': {
        const c = state.comments.find(x => x.id === ev.commentId)
        if (!c) continue
        if (!['open', 'resolved', 'outdated'].includes(ev.state)) continue
        c.state = ev.state
        if (ev.resolutionRef !== undefined) c.resolutionRef = ev.resolutionRef
        c.updatedAt = ev.at
        break
      }
      case 'comment-relocated': {
        const c = state.comments.find(x => x.id === ev.commentId)
        if (!c) continue
        if (typeof ev.version !== 'number' || ev.version < 1 || ev.version > state.latestVersion) continue
        if (ev.outcome === 'relocated') {
          c.version = ev.version
          c.anchor = ev.anchor
        } else {
          c.state = 'outdated'
        }
        c.updatedAt = ev.at
        break
      }
      default:
        break
    }
  }
  return sawVersion ? state : null
}

export function readReviewArtifactState(id: string): ReviewArtifactState | null {
  try {
    if (!isReviewArtifactId(id)) return null
    const raw = readFileSync(journalPath(id), 'utf8')
    return foldJournal(id, raw)
  } catch {
    return null
  }
}

export function readReviewArtifactJournal(id: string): ReviewJournalEvent[] {
  try {
    if (!isReviewArtifactId(id)) return []
    const raw = readFileSync(journalPath(id), 'utf8')
    const out: ReviewJournalEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const ev = decodeEvent(line)
      if (ev) out.push(ev)
    }
    return out
  } catch {
    return []
  }
}

export function listReviewArtifactHeadsSource(filter?: {
  sessionId?: string
  root?: string
}): SourceState<ReviewArtifactHead[]> {
  let root: string
  try {
    root = reviewArtifactsRoot()
  } catch (e) {
    return classifyReadFailure(e)
  }
  if (!existsSync(root)) return sourceEmpty()
  try {
    const heads: ReviewArtifactHead[] = []
    for (const entry of readdirSync(root)) {
      if (!isReviewArtifactId(entry)) continue
      const state = readReviewArtifactState(entry)
      if (!state) continue
      const latest = state.versions[state.versions.length - 1]!
      if (filter?.sessionId && latest.producer.sessionId !== filter.sessionId) continue
      if (filter?.root && !sameRootIdentity(latest.workspace.roots[0], filter.root)) continue
      const head: ReviewArtifactHead = {
        id: state.id,
        kind: state.kind,
        title: state.title,
        latestVersion: state.latestVersion,
        status: state.statuses[state.latestVersion] ?? 'draft',
        producerSessionId: latest.producer.sessionId,
        openComments: state.comments.filter(c => c.state === 'open').length,
        updatedAt: state.updatedAt,
      }
      if (latest.workspace.treeDigest !== undefined) head.treeDigest = latest.workspace.treeDigest
      heads.push(head)
    }
    const sorted = heads.sort((a, b) => b.updatedAt - a.updatedAt)
    return sorted.length === 0 ? sourceEmpty() : sourceReady(sorted)
  } catch (e) {
    return classifyReadFailure(e)
  }
}

export function listReviewArtifactHeads(filter?: {
  sessionId?: string
  root?: string
}): ReviewArtifactHead[] {
  return valueOr(listReviewArtifactHeadsSource(filter), [])
}


export type ReviewWriteResult<T> = { ok: true; value: T } | { ok: false; reason: string }

function bodyOversize(body: ReviewArtifactBody): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8') > BODY_MAX_BYTES
  } catch {
    return true
  }
}

export function createReviewArtifact(input: {
  kind: ReviewArtifactKind
  title: string
  producer: ReviewArtifactProducer
  workspace: ReviewArtifactWorkspace
  body: ReviewArtifactBody
  evidenceRefs?: string[]
  initialStatus?: Extract<ReviewArtifactStatus, 'draft' | 'ready-for-review'>
}): ReviewWriteResult<{ id: string; version: number }> {
  if (input.body.kind !== input.kind) {
    return { ok: false, reason: `body kind '${input.body.kind}' does not match artifact kind '${input.kind}'` }
  }
  if (bodyOversize(input.body)) {
    return { ok: false, reason: `body exceeds ${BODY_MAX_BYTES} bytes inline — link large payloads as resource refs` }
  }
  let id = `ra-${randomBytes(4).toString('hex')}`
  for (let i = 0; i < 8 && existsSync(path.join(reviewArtifactsRoot(), id)); i++) {
    id = `ra-${randomBytes(4).toString('hex')}`
  }
  return fencedWrite(id, () => {
    if (readReviewArtifactState(id)) {
      return { ok: false, reason: `artifact id collision on '${id}' — retry` }
    }
    const at = Date.now()
    const record: ReviewArtifactVersion = {
      schema: 1,
      id,
      version: 1,
      kind: input.kind,
      title: input.title,
      producer: input.producer,
      workspace: input.workspace,
      createdAt: at,
      body: input.body,
      evidenceRefs: input.evidenceRefs ?? [],
    }
    appendEvents(id, [
      { v: 1, at, type: 'version', record },
      { v: 1, at, type: 'status', version: 1, status: input.initialStatus ?? 'draft' },
    ])
    mirrorReviewStatusToCrew(id, input.title, input.initialStatus ?? 'draft', 1)
    return { ok: true, value: { id, version: 1 } }
  })
}

const mirrorChains = new Map<string, Promise<void>>()

function mirrorReviewStatusToCrew(
  artifactId: string,
  title: string,
  status: ReviewArtifactStatus,
  version: number,
): void {
  const prior = mirrorChains.get(artifactId) ?? Promise.resolve()
  const next = prior
    .then(async () => {
      const { crewDirectoryEnabled, resolveAgent } = await import('../../services/crew/identity.js')
      if (!crewDirectoryEnabled()) return
      const conv = await import('../../services/crew/conversations.js')
      const ref = `mercury://artifact/${artifactId}`
      if (status === 'ready-for-review') {
        await conv.upsertUnresolvedEvent(conv.MAIN_CONVERSATION_ID, {
          kind: 'review-request',
          label: title.slice(0, 60),
          ref,
        })
      } else if (status === 'accepted' || status === 'reviewed' || status === 'revision-requested') {
        await conv.resolveEventByRef(conv.MAIN_CONVERSATION_ID, 'review-request', ref)
      }
      const mainAgent = await resolveAgent('principal:agent-mercury')
      if (mainAgent) {
        const { ingestActivity } = await import('../../services/crew/activity.js')
        ingestActivity({
          event: {
            sourceEventId: `review-${artifactId}-v${version}-${status}`,
            kind: 'mercury.review',
            payload: { artifactId, title, status, version },
            atMs: Date.now(),
          },
          agentId: mainAgent,
          sessionId: 'main',
          adapterKind: 'mercury',
        })
      }
    })
    .catch(() => {
    })
  mirrorChains.set(artifactId, next)
  void next.finally(() => {
    if (mirrorChains.get(artifactId) === next) mirrorChains.delete(artifactId)
  })
}

export interface RelocationReport {
  relocated: string[]
  outdated: Array<{ commentId: string; reason: string }>
}

export function reviseReviewArtifact(input: {
  id: string
  title?: string
  body: ReviewArtifactBody
  evidenceRefs?: string[]
  producer: ReviewArtifactProducer
  workspace: ReviewArtifactWorkspace
}): ReviewWriteResult<{ version: number; relocation: RelocationReport }> {
  return fencedWrite(input.id, () => reviseReviewArtifactLocked(input))
}

function reviseReviewArtifactLocked(input: {
  id: string
  title?: string
  body: ReviewArtifactBody
  evidenceRefs?: string[]
  producer: ReviewArtifactProducer
  workspace: ReviewArtifactWorkspace
}): ReviewWriteResult<{ version: number; relocation: RelocationReport }> {
  const state = readReviewArtifactState(input.id)
  if (!state) return { ok: false, reason: `no review artifact '${input.id}'` }
  if (input.body.kind !== state.kind) {
    return { ok: false, reason: `body kind '${input.body.kind}' does not match artifact kind '${state.kind}'` }
  }
  if (bodyOversize(input.body)) {
    return { ok: false, reason: `body exceeds ${BODY_MAX_BYTES} bytes inline — link large payloads as resource refs` }
  }
  const at = Date.now()
  const prior = state.latestVersion
  const version = prior + 1
  const record: ReviewArtifactVersion = {
    schema: 1,
    id: input.id,
    version,
    kind: state.kind,
    title: input.title ?? state.title,
    producer: input.producer,
    workspace: input.workspace,
    createdAt: at,
    body: input.body,
    evidenceRefs: input.evidenceRefs ?? [],
    priorVersion: prior,
  }
  const events: ReviewJournalEvent[] = [
    { v: 1, at, type: 'version', record },
    { v: 1, at, type: 'status', version: prior, status: 'superseded' },
    { v: 1, at, type: 'status', version, status: 'ready-for-review' },
  ]
  const relocation: RelocationReport = { relocated: [], outdated: [] }
  for (const comment of state.comments) {
    if (comment.state !== 'open') continue
    const result = relocateAnchor(input.body, comment.anchor)
    if (result.outcome === 'relocated') {
      relocation.relocated.push(comment.id)
      events.push({
        v: 1,
        at,
        type: 'comment-relocated',
        commentId: comment.id,
        version,
        anchor: result.anchor,
        outcome: 'relocated',
      })
    } else {
      relocation.outdated.push({ commentId: comment.id, reason: result.reason })
      events.push({
        v: 1,
        at,
        type: 'comment-relocated',
        commentId: comment.id,
        version: comment.version,
        anchor: comment.anchor,
        outcome: 'outdated',
      })
    }
  }
  appendEvents(input.id, events)
  mirrorReviewStatusToCrew(input.id, record.title, 'ready-for-review', version)
  return { ok: true, value: { version, relocation } }
}

export function setReviewArtifactStatus(input: {
  id: string
  version: number
  status: ReviewArtifactStatus
  by?: string
}): ReviewWriteResult<{ status: ReviewArtifactStatus }> {
  return fencedWrite(input.id, () => setReviewArtifactStatusLocked(input))
}

function setReviewArtifactStatusLocked(input: {
  id: string
  version: number
  status: ReviewArtifactStatus
  by?: string
}): ReviewWriteResult<{ status: ReviewArtifactStatus }> {
  const state = readReviewArtifactState(input.id)
  if (!state) return { ok: false, reason: `no review artifact '${input.id}'` }
  if (input.version < 1 || input.version > state.latestVersion) {
    return { ok: false, reason: `no version ${input.version} (latest is ${state.latestVersion})` }
  }
  if (input.status === 'superseded') {
    return { ok: false, reason: "'superseded' is set by revision, never manually" }
  }
  const current = state.statuses[input.version] ?? 'draft'
  if (!canTransitionStatus(current, input.status)) {
    return { ok: false, reason: `illegal status transition ${current} → ${input.status}` }
  }
  const event: ReviewJournalEvent = {
    v: 1,
    at: Date.now(),
    type: 'status',
    version: input.version,
    status: input.status,
    ...(input.by !== undefined && { by: input.by }),
  }
  appendEvents(input.id, [event])
  mirrorReviewStatusToCrew(input.id, state.title, input.status, input.version)
  return { ok: true, value: { status: input.status } }
}

export function addReviewComment(input: {
  artifactId: string
  version: number
  anchor: ReviewAnchor
  author: string
  authorRef?: ReviewActorRef
  parentCommentId?: string
  body: string
}): ReviewWriteResult<{ commentId: string }> {
  return fencedWrite(input.artifactId, () => addReviewCommentLocked(input))
}

function addReviewCommentLocked(input: {
  artifactId: string
  version: number
  anchor: ReviewAnchor
  author: string
  authorRef?: ReviewActorRef
  parentCommentId?: string
  body: string
}): ReviewWriteResult<{ commentId: string }> {
  const state = readReviewArtifactState(input.artifactId)
  if (!state) return { ok: false, reason: `no review artifact '${input.artifactId}'` }
  const version = state.versions.find(v => v.version === input.version)
  if (!version) {
    return { ok: false, reason: `no version ${input.version} (latest is ${state.latestVersion})` }
  }
  const valid = validateAnchor(version.body, input.anchor)
  if (!valid.ok) {
    return { ok: false, reason: `anchor does not validate against v${input.version}: ${valid.reason}` }
  }
  if (input.parentCommentId !== undefined && !state.comments.some(c => c.id === input.parentCommentId)) {
    return { ok: false, reason: `no parent comment '${input.parentCommentId}' — a reply needs its thread` }
  }
  const commentId = `rc-${randomBytes(4).toString('hex')}`
  appendEvents(input.artifactId, [
    {
      v: 1,
      at: Date.now(),
      type: 'comment',
      comment: {
        id: commentId,
        version: input.version,
        anchor: input.anchor,
        author: input.author,
        ...(input.authorRef !== undefined ? { authorRef: input.authorRef } : {}),
        ...(input.parentCommentId !== undefined ? { parentCommentId: input.parentCommentId } : {}),
        body: input.body,
      },
    },
  ])
  return { ok: true, value: { commentId } }
}

export function recordReviewScopeDecision(input: {
  artifactId: string
  version: number
  scope: ReviewScope
  decision: ReviewScopeDecisionKind
  by?: string
  authorRef?: ReviewActorRef
}): ReviewWriteResult<{ fold: ScopeDecisionFold }> {
  return fencedWrite(input.artifactId, () => recordReviewScopeDecisionLocked(input))
}

function recordReviewScopeDecisionLocked(input: {
  artifactId: string
  version: number
  scope: ReviewScope
  decision: ReviewScopeDecisionKind
  by?: string
  authorRef?: ReviewActorRef
}): ReviewWriteResult<{ fold: ScopeDecisionFold }> {
  const state = readReviewArtifactState(input.artifactId)
  if (!state) return { ok: false, reason: `no review artifact '${input.artifactId}'` }
  const version = state.versions.find(v => v.version === input.version)
  if (!version) {
    return { ok: false, reason: `no version ${input.version} (latest is ${state.latestVersion})` }
  }
  const scopeValid = validateScope(version.body, input.scope)
  if (!scopeValid.ok) {
    return { ok: false, reason: `scope does not validate against v${input.version}: ${scopeValid.reason}` }
  }
  appendEvents(input.artifactId, [
    {
      v: 1,
      at: Date.now(),
      type: 'scope-decision',
      version: input.version,
      scope: input.scope,
      decision: input.decision,
      ...(input.by !== undefined ? { by: input.by } : {}),
      ...(input.authorRef !== undefined ? { authorRef: input.authorRef } : {}),
    },
  ])
  const after = readReviewArtifactState(input.artifactId)
  return {
    ok: true,
    value: { fold: foldScopeDecisions(after?.scopeDecisions ?? [], input.version) },
  }
}

function validateScope(
  body: ReviewArtifactVersion['body'],
  scope: ReviewScope,
): { ok: true } | { ok: false; reason: string } {
  switch (scope.t) {
    case 'whole':
      return { ok: true }
    case 'file':
      if (body.kind !== 'diff') return { ok: false, reason: `no files in a '${body.kind}' body` }
      return body.files.some(f => f.path === scope.path)
        ? { ok: true }
        : { ok: false, reason: `no file '${scope.path}' in the diff` }
    case 'hunk': {
      if (body.kind !== 'diff') return { ok: false, reason: `no hunks in a '${body.kind}' body` }
      const file = body.files.find(f => f.path === scope.path)
      if (!file) return { ok: false, reason: `no file '${scope.path}' in the diff` }
      return scope.hunkIndex >= 0 && scope.hunkIndex < file.hunks.length
        ? { ok: true }
        : { ok: false, reason: `no hunk #${scope.hunkIndex} in '${scope.path}'` }
    }
    case 'plan-item':
      return body.kind === 'plan' || body.kind === 'walkthrough' || body.kind === 'report'
        ? { ok: true }
        : { ok: false, reason: `no plan items in a '${body.kind}' body` }
    case 'vis-region':
      if (body.kind !== 'visual') return { ok: false, reason: `no captures in a '${body.kind}' body` }
      return body.captures.some(c => c.ref === scope.captureRef)
        ? { ok: true }
        : { ok: false, reason: `no capture '${scope.captureRef}'` }
    case 'journey-step':
      if (body.kind !== 'journey') return { ok: false, reason: `no steps in a '${body.kind}' body` }
      return body.steps.some(s => s.id === scope.stepId)
        ? { ok: true }
        : { ok: false, reason: `no step '${scope.stepId}'` }
    case 'check':
      return scope.claim.trim() !== ''
        ? { ok: true }
        : { ok: false, reason: 'empty check claim' }
  }
}

export function setReviewCommentState(input: {
  artifactId: string
  commentId: string
  state: Extract<ReviewComment['state'], 'open' | 'resolved'>
  resolutionRef?: string
  by?: string
  authorRef?: ReviewActorRef
}): ReviewWriteResult<Record<string, never>> {
  return fencedWrite(input.artifactId, () => setReviewCommentStateLocked(input))
}

function setReviewCommentStateLocked(input: {
  artifactId: string
  commentId: string
  state: Extract<ReviewComment['state'], 'open' | 'resolved'>
  resolutionRef?: string
  by?: string
  authorRef?: ReviewActorRef
}): ReviewWriteResult<Record<string, never>> {
  const state = readReviewArtifactState(input.artifactId)
  if (!state) return { ok: false, reason: `no review artifact '${input.artifactId}'` }
  const comment = state.comments.find(c => c.id === input.commentId)
  if (!comment) return { ok: false, reason: `no comment '${input.commentId}'` }
  if (comment.state === 'outdated' && input.state === 'resolved') {
    return { ok: false, reason: 'an outdated comment cannot be resolved — reopen it against a live anchor first' }
  }
  const event: ReviewJournalEvent = {
    v: 1,
    at: Date.now(),
    type: 'comment-state',
    commentId: input.commentId,
    state: input.state,
    ...(input.resolutionRef !== undefined && { resolutionRef: input.resolutionRef }),
    ...(input.by !== undefined && { by: input.by }),
    ...(input.authorRef !== undefined && { authorRef: input.authorRef }),
  }
  appendEvents(input.artifactId, [event])
  return { ok: true, value: {} }
}
