
import type { ActorRefV1 } from '../../services/crew/identity.js'

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
  ref: string
  title?: string
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
  delta?: string
  result?: string
}

export interface WalkthroughClaim {
  text: string
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
  id: string
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
  version: number
  anchor: ReviewAnchor
  author: string
  authorRef?: ReviewActorRef
  parentCommentId?: string
  body: string
  state: ReviewCommentState
  resolutionRef?: string
  createdAt: number
  updatedAt: number
}


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
  latest: Map<string, ReviewScopeDecision>
  accepted: number
  revisionRequested: number
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
  title: string
  versions: ReviewArtifactVersion[]
  statuses: Record<number, ReviewArtifactStatus>
  comments: ReviewComment[]
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
