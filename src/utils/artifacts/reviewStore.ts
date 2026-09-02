// ============================================================================
//  artifacts/reviewStore — the durable immutable-versioned review-artifact
//  store, extending the artifact owner with the version chain
//  the flat blob store lacks.
//
//  Discipline = the TABULA journal pattern: ONE append-only journal.jsonl
//  per artifact is the source of truth; every mutation is an appended event
//  (single O_APPEND write, lead-newline torn-tail repair, line-wise
//  defensive fold); nothing ever rewrites history — a published version's
//  record stays byte-identical in the journal forever. This store is
//  PRUNE-EXEMPT by construction (its own root, never swept by the blob
//  store's retention).
//
//  Anchor law: a comment is only accepted when its anchor VALIDATES against
//  the version body (locations are never invented — the repoHost
//  reviewRecord rule); revision relocates open comments by content identity
//  or marks them OUTDATED, and the relocation itself is a recorded event.
// ============================================================================

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

/** Inline body ceiling — larger payloads must ride refs (images/patches/logs
 * link existing resources; brief). */
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

/** Same-project identity for scoping (darwin /var vs /private/var class). */
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

/** Damaged-vs-absent probe for the adapter (absent ≠ unreadable). */
export function reviewArtifactJournalExists(id: string): boolean {
  try {
    return isReviewArtifactId(id) && existsSync(journalPath(id))
  } catch {
    return false
  }
}

// ── the per-artifact WRITE FENCE ────────────────────────────────────────────
// Every writer is read→validate→append; two processes (the session + an ACP
// child, both shipped) racing that sequence can fold a phantom revision or
// an out-of-ladder status. A lock
// directory (mkdir is atomic-exclusive on every platform we ship) makes the
// whole sequence exclusive per artifact; stale locks (a crashed holder) are
// reaped by age. Writers do their READS INSIDE the fence.

const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The fence's owner token: pid plus a per-acquire nonce, written inside the
 *  lock directory so release can tell OUR lock from a successor's. A reaped
 *  lock re-taken by another writer carries a different token; the slow
 *  original must then leave it alone (sweep #2 item 73). */
export function artifactLockOwnedBy(lock: string, token: string): boolean {
  try {
    return readFileSync(path.join(lock, 'owner'), 'utf8') === token
  } catch {
    // No token (a pre-token lock, or a lock already reaped): release as before.
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
        /* the directory IS the lock; the token only sharpens release */
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
        continue // holder released between attempts
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
        /* already reaped */
      }
    }
  }
}

/** Run a writer under the fence, mapping thrown IO/lock errors into the
 *  honest ReviewWriteResult contract (never an escaping exception). */
function fencedWrite<T>(id: string, fn: () => ReviewWriteResult<T>): ReviewWriteResult<T> {
  try {
    return withArtifactLock(id, fn)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `write failed: ${msg.slice(0, 200)}` }
  }
}

// ── journal append (TABULA torn-tail law) ───────────────────────────────────

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

// ── fold (defensive, line-wise; a torn tail loses one record, never all) ────

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
        // Dense, monotonic versions only — a replayed/duplicate event no-ops.
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
        // Defensive fold: a comment for a version that never folded (torn
        // sibling record) must not dangle into the head counts.
        if (typeof c.version !== 'number' || c.version < 1 || c.version > state.latestVersion) continue
        if (state.comments.some(x => x.id === c.id)) continue
        // M7 thread integrity: a reply whose parent never folded (torn
        // sibling) lands as a top-level comment rather than dangling.
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

/** The raw append-only journal, decoded line-wise (HZ7 — the Audit
 *  depth's complete chronology). Same defensive fold discipline as state: a
 *  torn tail loses one record, never all. */
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

/**
 * The enumeration WITH its read outcome. An absent store is
 * a genuine emptiness; a store root that exists and cannot be enumerated is a
 * source we could not observe, and reporting that as "no artifacts" is the
 * confident false statement this owner exists to prevent.
 */
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

/**
 * Value-or-empty view for callers that cannot act on the distinction. A `[]`
 * from here may mean "the store could not be read" — new call sites that
 * RENDER a count should take listReviewArtifactHeadsSource instead and say
 * which it was.
 */
export function listReviewArtifactHeads(filter?: {
  sessionId?: string
  /** Scope to artifacts PRODUCED on this workspace root (realpath-insensitive
   *  prefix match) — the store is home-scoped, surfaces are project-scoped. */
  root?: string
}): ReviewArtifactHead[] {
  return valueOr(listReviewArtifactHeadsSource(filter), [])
}

// ── writes ──────────────────────────────────────────────────────────────────

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
  // 32-bit ids: a collision would silently splice into a FOREIGN journal.
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

/**
 * M8: a review status
 * mirrors into the crew surfaces as bounded projections — ready-for-review
 * appends ONE unresolved review-request event on the main conversation (the
 * inbox's ready-to-review bucket input) and a decision resolves it; every
 * transition also lands one artifact-class activity row. Fire-and-forget
 * behind the crew flag (the minerva.ts precedent): the review journal stays
 * the truth; a failed mirror loses a projection, never a record.
 */
/** Per-artifact mirror serialization: transitions apply to the conversation
 *  in the order they were made — a resolve can never race ahead of the
 *  append it settles (the wave-B TOCTOU finding). */
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
        // Dedupe + append are ONE store mutation (atomic upsert).
        await conv.upsertUnresolvedEvent(conv.MAIN_CONVERSATION_ID, {
          kind: 'review-request',
          label: title.slice(0, 60),
          ref,
        })
      } else if (status === 'accepted' || status === 'reviewed' || status === 'revision-requested') {
        // Find + stamp are ONE store mutation (atomic resolve-by-ref).
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
      // the review journal is the truth; the mirror is a bounded projection
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
  // Relocate every OPEN comment against the new body — by content identity
  // only; ambiguity or absence reads OUTDATED, and either way the outcome is
  // a recorded event (never a silent reattach).
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
  // The revision loop returns to the crew inbox: the NEW version awaits
  // review (the same mirror every other transition rides).
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
  /** M7 reply lineage: the parent comment this one answers (same artifact). */
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

/** M7: record a per-scope decision (accept / request-revision at file · hunk
 *  · plan item · visual region · journey step · check · whole). The scope
 *  validates against the version's own body; the LAST decision per scope
 *  wins the fold (foldScopeDecisions) — the artifact-level status remains
 *  the explicit verbs' decision, never auto-folded. */
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

/** A scope names a unit the version's body actually carries — a decision on
 *  a vanished file/step is refused, never silently recorded. */
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
      // Check results live in the evidence plane beside the artifact — the
      // claim string is the stable scope key; presence is not body-derivable.
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
