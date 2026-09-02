// ============================================================================
//  artifacts/reviewContracts — the immutable versioned
//  review-artifact vocabulary.
//
//  Laws:
//    · a published VERSION is immutable — revision appends version n+1 and
//      supersedes n, never rewrites it;
//    · every version binds producer (session/turn/agent/lane) + workspace
//      (roots + tree digest) — an older-tree artifact is visibly stale;
//    · comments are ADDITIVE, anchored by content-derived identity, and
//      relocate only when unambiguous — otherwise they read OUTDATED;
//    · large payloads (images, full patches, logs) ride refs to existing
//      resources, never inline duplication.
//
//  M7 extends the vocabulary in place (append-only journal —
//  old events decode unchanged):
//    · comments THREAD (parentCommentId — reply lineage, never a move) and
//      carry typed authorship (authorRef, an ActorRef) BESIDE the legacy
//      string author;
//    · per-SCOPE decisions (scope-decision events over ReviewScope: file ·
//      hunk · plan item · visual region · journey step · check · whole) with
//      ONE documented global fold (foldScopeDecisions) — the fold SUGGESTS,
//      the artifact-level status stays the explicit operator decision.
// ============================================================================

import type { ActorRefV1 } from '../../services/crew/identity.js'

/** Typed authorship — the crew ActorRef vocabulary (humans stay principals,
 *  agents ride the registry). Carried BESIDE the legacy string author. */
export type ReviewActorRef = ActorRefV1

export type ReviewArtifactKind =
  | 'plan'
  | 'diff'
  | 'visual'
  | 'journey'
  | 'walkthrough'
  | 'report'

export type ReviewArtifactStatus =
  | 'draft'
  | 'ready-for-review'
  | 'reviewed'
  | 'revision-requested'
  | 'accepted'
  | 'superseded'

export interface ReviewArtifactProducer {
  sessionId: string
  turn?: number
  agentId?: string
  laneId?: string
}

export interface ReviewArtifactWorkspace {
  roots: string[]
  treeDigest?: string
}

export interface ReviewRect {
  x: number
  y: number
  w: number
  h: number
}

export interface DiffBodyHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Unified-diff lines including the leading ' '/'+'/'-' marker. */
  lines: string[]
}

export interface DiffBodyFile {
  path: string
  hunks: DiffBodyHunk[]
}

export interface VisualBodyElement {
  id: string
  label?: string
  rect?: ReviewRect
}

export interface VisualBodyCapture {
  /** Resource ref to the image payload (mercury://artifact/… or file). */
  ref: string
  title?: string
  /** sha256 of the capture payload — region anchors survive only on an
   *  identical capture. */
  digest?: string
  elements?: VisualBodyElement[]
}

export interface JourneyBodyStep {
  id: string
  title: string
  action?: string
  pageId?: string
  beforeRef?: string
  afterRef?: string
  targetRef?: string
  /** Runtime-problem delta observed across the step (console/network). */
  delta?: string
  result?: string
}

export interface WalkthroughClaim {
  text: string
  /** Every factual claim carries the evidence it was assembled from. */
  evidenceRefs: string[]
}

export type ReviewArtifactBody =
  | { kind: 'plan'; markdown: string }
  | { kind: 'diff'; files: DiffBodyFile[]; baseLabel?: string; headLabel?: string }
  | { kind: 'visual'; captures: VisualBodyCapture[] }
  | { kind: 'journey'; steps: JourneyBodyStep[] }
  | { kind: 'walkthrough'; markdown: string; claims?: WalkthroughClaim[] }
  | { kind: 'report'; markdown: string }

export interface ReviewArtifactVersion {
  schema: 1
  /** Stable across versions. */
  id: string
  /** 1-based, dense, immutable once published. */
  version: number
  kind: ReviewArtifactKind
  title: string
  producer: ReviewArtifactProducer
  workspace: ReviewArtifactWorkspace
  createdAt: number
  body: ReviewArtifactBody
  evidenceRefs: string[]
  priorVersion?: number
}

// ── anchors (content-derived identity) ───────────────────────────────────────

export type ReviewAnchor =
  | { t: 'md-block'; headingPath: string[]; blockDigest: string; ordinal: number }
  | {
      t: 'diff-line'
      path: string
      side: 'old' | 'new'
      lineDigest: string
      hunkIndex: number
      line: number
    }
  | { t: 'vis-elem'; captureRef: string; elementId: string }
  | { t: 'vis-region'; captureRef: string; captureDigest?: string; rect: ReviewRect }
  | { t: 'journey-step'; stepId: string }
  | { t: 'whole' }

export type ReviewCommentState = 'open' | 'resolved' | 'outdated'

export interface ReviewComment {
  id: string
  artifactId: string
  /** The version the anchor currently targets (moves on relocation). */
  version: number
  anchor: ReviewAnchor
  author: string
  /** Typed authorship beside the legacy string (M7) — never routed on. */
  authorRef?: ReviewActorRef
  /** Reply lineage (M7): the parent comment this one answers. A reply is an
   *  ADDITIVE comment with lineage — threads never move or merge bodies. */
  parentCommentId?: string
  body: string
  state: ReviewCommentState
  resolutionRef?: string
  createdAt: number
  updatedAt: number
}

// ── per-scope decisions (M7) ─────────────────────────────────────────────────

/** The decidable SCOPES — coarser than comment anchors on purpose: a scope
 *  names a reviewable unit (a file, a hunk, a plan item, a visual region, a
 *  journey step, a check result, or the whole artifact). */
export type ReviewScope =
  | { t: 'file'; path: string }
  | { t: 'hunk'; path: string; hunkIndex: number }
  | { t: 'plan-item'; headingPath: string[] }
  | { t: 'vis-region'; captureRef: string; rect: ReviewRect }
  | { t: 'journey-step'; stepId: string }
  | { t: 'check'; claim: string }
  | { t: 'whole' }

export type ReviewScopeDecisionKind = 'accept' | 'request-revision'

export interface ReviewScopeDecision {
  version: number
  scope: ReviewScope
  decision: ReviewScopeDecisionKind
  by?: string
  authorRef?: ReviewActorRef
  at: number
}

/** ONE stable key per scope — the LAST decision for a key wins the fold. */
export function reviewScopeKey(scope: ReviewScope): string {
  switch (scope.t) {
    case 'file':
      return `file:${scope.path}`
    case 'hunk':
      return `hunk:${scope.path}#${scope.hunkIndex}`
    case 'plan-item':
      return `plan:${scope.headingPath.join('/')}`
    case 'vis-region':
      return `vis:${scope.captureRef}@${scope.rect.x},${scope.rect.y},${scope.rect.w},${scope.rect.h}`
    case 'journey-step':
      return `step:${scope.stepId}`
    case 'check':
      return `check:${scope.claim}`
    case 'whole':
      return 'whole'
  }
}

export interface ScopeDecisionFold {
  /** Latest decision per scope key (the fold's working set). */
  latest: Map<string, ReviewScopeDecision>
  accepted: number
  revisionRequested: number
  /** THE documented global fold: any scope holding request-revision ⇒
   *  'revision-requested'; some scopes decided and ALL accepted ⇒
   *  'accepted'; nothing decided ⇒ null. A SUGGESTION for the artifact-level
   *  verbs — never auto-applied (the explicit decision stays the operator's). */
  suggestion: Extract<ReviewArtifactStatus, 'accepted' | 'revision-requested'> | null
}

export function foldScopeDecisions(
  decisions: readonly ReviewScopeDecision[],
  version: number,
): ScopeDecisionFold {
  const latest = new Map<string, ReviewScopeDecision>()
  for (const d of decisions) {
    if (d.version !== version) continue
    latest.set(reviewScopeKey(d.scope), d)
  }
  let accepted = 0
  let revisionRequested = 0
  for (const d of latest.values()) {
    if (d.decision === 'accept') accepted++
    else revisionRequested++
  }
  return {
    latest,
    accepted,
    revisionRequested,
    suggestion:
      revisionRequested > 0 ? 'revision-requested' : accepted > 0 ? 'accepted' : null,
  }
}

// ── the journal (append-only; TABULA discipline) ────────────────────────────

export type ReviewJournalEvent =
  | { v: 1; at: number; type: 'version'; record: ReviewArtifactVersion }
  | { v: 1; at: number; type: 'status'; version: number; status: ReviewArtifactStatus; by?: string }
  | {
      v: 1
      at: number
      type: 'comment'
      comment: {
        id: string
        version: number
        anchor: ReviewAnchor
        author: string
        authorRef?: ReviewActorRef
        parentCommentId?: string
        body: string
      }
    }
  | {
      v: 1
      at: number
      type: 'comment-state'
      commentId: string
      state: ReviewCommentState
      resolutionRef?: string
      by?: string
      authorRef?: ReviewActorRef
    }
  | {
      v: 1
      at: number
      type: 'scope-decision'
      version: number
      scope: ReviewScope
      decision: ReviewScopeDecisionKind
      by?: string
      authorRef?: ReviewActorRef
    }
  | {
      v: 1
      at: number
      type: 'comment-relocated'
      commentId: string
      version: number
      anchor: ReviewAnchor
      outcome: 'relocated' | 'outdated'
    }

export interface ReviewArtifactState {
  id: string
  kind: ReviewArtifactKind
  /** Latest version's title. */
  title: string
  versions: ReviewArtifactVersion[]
  /** Workflow status per version. */
  statuses: Record<number, ReviewArtifactStatus>
  comments: ReviewComment[]
  /** Per-scope decisions in journal order (M7) — fold via foldScopeDecisions. */
  scopeDecisions: ReviewScopeDecision[]
  latestVersion: number
  createdAt: number
  updatedAt: number
}

export interface ReviewArtifactHead {
  id: string
  kind: ReviewArtifactKind
  title: string
  latestVersion: number
  status: ReviewArtifactStatus
  treeDigest?: string
  producerSessionId: string
  openComments: number
  updatedAt: number
}

/** The status ladder — every legal transition, mechanically enforced.
 *  'superseded' is never a manual target: revision sets it. */
const STATUS_TRANSITIONS: Record<ReviewArtifactStatus, ReviewArtifactStatus[]> = {
  draft: ['ready-for-review'],
  'ready-for-review': ['reviewed', 'revision-requested', 'accepted'],
  reviewed: ['accepted', 'revision-requested'],
  'revision-requested': [],
  accepted: [],
  superseded: [],
}

export function canTransitionStatus(
  from: ReviewArtifactStatus,
  to: ReviewArtifactStatus,
): boolean {
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false
}
