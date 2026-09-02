
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
  intentId: string
  kind: FolioActionKind
  artifactId: string
  version: number
  by?: string
  authorRef?: ReviewActorRef
  commentIds?: string[]
  producerAgentId?: string
  commentId?: string
  body?: string
  anchor?: ReviewAnchor
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
      fold: { accepted: number; revisionRequested: number; suggestion: ScopeDecisionFold['suggestion'] }
    }
  | { kind: 'refused'; intentId: string; reason: string }

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
  return remember({
    kind: 'feedback-retained',
    intentId: intent.intentId,
    artifactId: intent.artifactId,
    retained: open.length,
    reason: 'the owning session is not receiving — comments are retained in the review store; send again when it returns',
  })
}

export function _resetFolioActionReceiptsForTesting(): void {
  receipts.clear()
}
