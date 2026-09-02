// ============================================================================
//  workbench/folioActions — C1: the folio's ACTIONS, beside the
//  pure projection (folio.ts stays assembly-only — the architecture law).
//
//  One typed intent → receipt seam over the EXISTING owners:
//    · accept / mark-reviewed / request-revision → the review store's own
//      status vocabulary (accepted · reviewed · revision-requested), fenced
//      writes, refusals passed through verbatim.
//    · send-feedback → the artifact's OPEN comments routed to the owning
//      session over the EXISTING dispatch lanes (the one intent layer in
//      services/attention/actions): the producing session rides the main
//      queue (drain-while-open); a live producer agent rides the addressed
//      lane when the surface supplies its REAL agent id; otherwise the
//      comments are RETAINED — they already live durably in the review
//      store — and the receipt says so honestly (owner-unavailable law).
//
//  IDEMPOTENT: a replayed intentId returns its receipt without a second
//  owner write (a bounded ring — the collaboration op-index idiom, local).
//
//  Proved by scripts/attention/prove-folio-actions.ts; the module + export
//  shape is repro-journey-g's pin.
// ============================================================================

import {
  addReviewComment,
  readReviewArtifactState,
  recordReviewScopeDecision,
  setReviewArtifactStatus,
  setReviewCommentState,
} from '../../utils/artifacts/reviewStore.js'
import type {
  ReviewActorRef,
  ReviewAnchor,
  ReviewArtifactStatus,
  ReviewScope,
  ReviewScopeDecisionKind,
  ScopeDecisionFold,
} from '../../utils/artifacts/reviewContracts.js'
import { submitDispatch, submitReply } from '../../services/attention/actions.js'
import { getSessionId } from '../../bootstrap/state.js'

export const FOLIO_ACTION_KINDS = [
  'accept',
  'mark-reviewed',
  'request-revision',
  'send-feedback',
  // M7 — the interactive verbs: threaded replies, comment lifecycle, and
  // per-scope decisions (the fold suggests; the verbs above stay the
  // artifact-level decision).
  'reply',
  'resolve-comment',
  'reopen-comment',
  'scope-decision',
] as const
export type FolioActionKind = (typeof FOLIO_ACTION_KINDS)[number]

const STATUS_OF: Record<'accept' | 'mark-reviewed' | 'request-revision', ReviewArtifactStatus> = {
  accept: 'accepted',
  'mark-reviewed': 'reviewed',
  'request-revision': 'revision-requested',
}

export interface FolioActionIntent {
  /** Caller-minted correlation id — the idempotence key. */
  intentId: string
  kind: FolioActionKind
  /** The review artifact id (ra-…), from the folio's own ref. */
  artifactId: string
  version: number
  /** The deciding principal (recorded on the status event). */
  by?: string
  /** Typed authorship beside the string (M7) — recorded, never routed on. */
  authorRef?: ReviewActorRef
  /** send-feedback: restrict to these comment ids ([]/absent = all OPEN). */
  commentIds?: string[]
  /** send-feedback: the producer agent's REAL id when the surface knows it
   *  is live (the addressed-lane law — row ids never qualify). */
  producerAgentId?: string
  /** reply / resolve-comment / reopen-comment: the comment acted on. */
  commentId?: string
  /** reply: the reply body (anchors to the parent's own anchor). */
  body?: string
  /** reply: override the anchor (defaults to the parent's). */
  anchor?: ReviewAnchor
  /** scope-decision: the decided scope + verdict. */
  scope?: ReviewScope
  decision?: ReviewScopeDecisionKind
}

export type FolioActionReceipt =
  | {
      kind: 'applied'
      intentId: string
      action: FolioActionKind
      artifactId: string
      version: number
      status: ReviewArtifactStatus
      /** request-revision: where the revision REQUEST itself was routed
       *  (the producing session's queue · the producer agent's lane ·
       *  retained when neither is receiving). */
      revisionRequestRoute?: 'session' | 'agent' | 'retained'
    }
  | {
      kind: 'feedback-routed'
      intentId: string
      artifactId: string
      delivered: number
      route: 'session' | 'agent'
    }
  | {
      kind: 'feedback-retained'
      intentId: string
      artifactId: string
      retained: number
      reason: string
    }
  | { kind: 'comment-written'; intentId: string; artifactId: string; commentId: string; parentCommentId?: string }
  | { kind: 'comment-state-set'; intentId: string; artifactId: string; commentId: string; state: 'open' | 'resolved' }
  | {
      kind: 'scope-decided'
      intentId: string
      artifactId: string
      version: number
      decision: ReviewScopeDecisionKind
      /** The documented global fold AFTER this decision — a suggestion for
       *  the artifact-level verbs, never auto-applied. */
      fold: { accepted: number; revisionRequested: number; suggestion: ScopeDecisionFold['suggestion'] }
    }
  | { kind: 'refused'; intentId: string; reason: string }

/** Bounded replay ring — the same intentId returns its receipt, no second
 *  owner write. The bound is generous: the board's intent ids are
 *  DETERMINISTIC (content-derived), so eviction only matters across 256
 *  distinct actions — never across repeat presses of one action. */
const RING_MAX = 256
const receipts = new Map<string, FolioActionReceipt>()
function remember(r: FolioActionReceipt): FolioActionReceipt {
  receipts.set(r.intentId, r)
  if (receipts.size > RING_MAX) {
    const oldest = receipts.keys().next().value
    if (oldest !== undefined) receipts.delete(oldest)
  }
  return r
}

export async function applyFolioAction(intent: FolioActionIntent): Promise<FolioActionReceipt> {
  const replay = receipts.get(intent.intentId)
  if (replay) return replay

  // ── M7: threaded replies + comment lifecycle + per-scope decisions ────────
  if (intent.kind === 'reply') {
    if (!intent.commentId || !intent.body || intent.body.trim() === '') {
      return remember({ kind: 'refused', intentId: intent.intentId, reason: 'a reply needs its parent commentId and a body' })
    }
    const state = readReviewArtifactState(intent.artifactId)
    const parent = state?.comments.find(c => c.id === intent.commentId)
    if (!parent) {
      return remember({ kind: 'refused', intentId: intent.intentId, reason: `no parent comment '${intent.commentId}'` })
    }
    const r = addReviewComment({
      artifactId: intent.artifactId,
      version: parent.version,
      anchor: intent.anchor ?? parent.anchor,
      author: intent.by ?? 'operator',
      ...(intent.authorRef !== undefined ? { authorRef: intent.authorRef } : {}),
      parentCommentId: parent.id,
      body: intent.body,
    })
    if (!r.ok) return remember({ kind: 'refused', intentId: intent.intentId, reason: r.reason })
    return remember({
      kind: 'comment-written',
      intentId: intent.intentId,
      artifactId: intent.artifactId,
      commentId: r.value.commentId,
      parentCommentId: parent.id,
    })
  }
  if (intent.kind === 'resolve-comment' || intent.kind === 'reopen-comment') {
    if (!intent.commentId) {
      return remember({ kind: 'refused', intentId: intent.intentId, reason: 'no commentId' })
    }
    const target = intent.kind === 'resolve-comment' ? ('resolved' as const) : ('open' as const)
    const r = setReviewCommentState({
      artifactId: intent.artifactId,
      commentId: intent.commentId,
      state: target,
      ...(intent.by !== undefined ? { by: intent.by } : {}),
      ...(intent.authorRef !== undefined ? { authorRef: intent.authorRef } : {}),
    })
    if (!r.ok) return remember({ kind: 'refused', intentId: intent.intentId, reason: r.reason })
    return remember({
      kind: 'comment-state-set',
      intentId: intent.intentId,
      artifactId: intent.artifactId,
      commentId: intent.commentId,
      state: target,
    })
  }
  if (intent.kind === 'scope-decision') {
    if (!intent.scope || !intent.decision) {
      return remember({ kind: 'refused', intentId: intent.intentId, reason: 'a scope decision needs scope + decision' })
    }
    const r = recordReviewScopeDecision({
      artifactId: intent.artifactId,
      version: intent.version,
      scope: intent.scope,
      decision: intent.decision,
      ...(intent.by !== undefined ? { by: intent.by } : {}),
      ...(intent.authorRef !== undefined ? { authorRef: intent.authorRef } : {}),
    })
    if (!r.ok) return remember({ kind: 'refused', intentId: intent.intentId, reason: r.reason })
    return remember({
      kind: 'scope-decided',
      intentId: intent.intentId,
      artifactId: intent.artifactId,
      version: intent.version,
      decision: intent.decision,
      fold: {
        accepted: r.value.fold.accepted,
        revisionRequested: r.value.fold.revisionRequested,
        suggestion: r.value.fold.suggestion,
      },
    })
  }

  if (intent.kind !== 'send-feedback') {
    const r = setReviewArtifactStatus({
      id: intent.artifactId,
      version: intent.version,
      status: STATUS_OF[intent.kind],
      ...(intent.by !== undefined ? { by: intent.by } : {}),
    })
    if (!r.ok) return remember({ kind: 'refused', intentId: intent.intentId, reason: r.reason })
    // M7: a revision REQUEST travels to the producing agent with a receipt —
    // the same owner-routing as send-feedback (the producing session's queue,
    // the producer agent's addressed lane, or honest retention).
    let revisionRequestRoute: 'session' | 'agent' | 'retained' | undefined
    if (intent.kind === 'request-revision') {
      const state = readReviewArtifactState(intent.artifactId)
      const head = state?.versions.find(v => v.version === state.latestVersion)
      const title = head?.title ?? intent.artifactId
      const message =
        `Revision requested on "${title}" (mercury://artifact/${intent.artifactId}, v${intent.version}): ` +
        `address the open comments and scope decisions in the review store, then revise the SAME artifact ` +
        `(id ${intent.artifactId}) — a new version of the same folio linked to this request, never a new artifact.`
      const producerSession = head?.producer.sessionId
      const producerAgent = intent.producerAgentId ?? head?.producer.agentId
      if (producerSession && producerSession === getSessionId()) {
        const d = await submitDispatch({ intentId: `${intent.intentId}-rr`, kind: 'board-dispatch', value: message })
        revisionRequestRoute = d.kind === 'dispatch-accepted' ? 'session' : 'retained'
      } else if (producerAgent) {
        const d = await submitReply({
          intentId: `${intent.intentId}-rr`,
          targetSubjectId: `thread:${producerAgent}`,
          agentId: producerAgent,
          value: message,
        })
        revisionRequestRoute = d.kind === 'dispatch-accepted' ? 'agent' : 'retained'
      } else {
        revisionRequestRoute = 'retained'
      }
    }
    return remember({
      kind: 'applied',
      intentId: intent.intentId,
      action: intent.kind,
      artifactId: intent.artifactId,
      version: intent.version,
      status: r.value.status,
      ...(revisionRequestRoute !== undefined ? { revisionRequestRoute } : {}),
    })
  }

  // send-feedback
  const state = readReviewArtifactState(intent.artifactId)
  if (!state) {
    return remember({
      kind: 'refused',
      intentId: intent.intentId,
      reason: `no review artifact '${intent.artifactId}'`,
    })
  }
  const open = state.comments.filter(
    c =>
      c.state === 'open' &&
      (!intent.commentIds || intent.commentIds.length === 0 || intent.commentIds.includes(c.id)),
  )
  if (open.length === 0) {
    return remember({
      kind: 'refused',
      intentId: intent.intentId,
      reason: 'no open comments to send',
    })
  }
  const head = state.versions.find(v => v.version === state.latestVersion)
  const title = head?.title ?? intent.artifactId
  const body =
    `Review feedback on "${title}" (mercury://artifact/${intent.artifactId}, v${state.latestVersion}):\n` +
    open
      .map(c => `- [${c.id} @ ${c.anchor.t}] ${c.body}`)
      .join('\n') +
    `\nAddress each point; comments resolve in the review store as you go.`

  const producerSession = head?.producer.sessionId
  if (producerSession && producerSession === getSessionId()) {
    const r = await submitDispatch({
      intentId: intent.intentId,
      kind: 'board-dispatch',
      value: body,
    })
    if (r.kind !== 'dispatch-accepted') {
      return remember({ kind: 'refused', intentId: intent.intentId, reason: r.reason })
    }
    return remember({
      kind: 'feedback-routed',
      intentId: intent.intentId,
      artifactId: intent.artifactId,
      delivered: open.length,
      route: 'session',
    })
  }
  // The agent lane resolves from the caller's knowledge OR the artifact's
  // OWN producer binding (wave-C review: the board never supplies an agent
  // id, so without the owner fallback the lane was unreachable from its one
  // production caller).
  const producerAgent = intent.producerAgentId ?? head?.producer.agentId
  if (producerAgent) {
    const r = await submitReply({
      intentId: intent.intentId,
      targetSubjectId: `thread:${producerAgent}`,
      agentId: producerAgent,
      value: body,
    })
    if (r.kind !== 'dispatch-accepted') {
      return remember({ kind: 'refused', intentId: intent.intentId, reason: r.reason })
    }
    return remember({
      kind: 'feedback-routed',
      intentId: intent.intentId,
      artifactId: intent.artifactId,
      delivered: open.length,
      route: 'agent',
    })
  }
  // Owner unavailable — the comments already live durably in the review
  // store (additive journal); the receipt offers the later delivery.
  return remember({
    kind: 'feedback-retained',
    intentId: intent.intentId,
    artifactId: intent.artifactId,
    retained: open.length,
    reason: 'the owning session is not receiving — comments are retained in the review store; send again when it returns',
  })
}

/** Test seam. */
export function _resetFolioActionReceiptsForTesting(): void {
  receipts.clear()
}
