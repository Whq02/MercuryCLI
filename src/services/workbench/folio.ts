// ============================================================================
//  workbench/folio — the Evidence Folio projection.
//
//  Three depths over one completed piece of work, ASSEMBLED on read from the
//  owners that already hold the facts — the review store (versions · journal ·
//  comments), the change-receipt ring (observed mutations), and the evidence
//  plane (canonical check records). No store of its own and no copied
//  artifact bodies: every field is a projection of an existing owner, and the
//  refs it carries are the owners' own mercury:// refs, so a folio can never
//  say more than its sources can prove.
//
//    Glance  — outcome · elapsed · changed-file count · check summary
//              (the sideInfo card: one look answers "how did it go").
//    Inspect — grouped actions (receipts by tool family) · changed files ·
//              check rows with their origin honesty · comment counts ·
//              visuals · the walkthrough's claims.
//    Audit   — the complete chronology (journal events + receipts, time-
//              ordered) and the raw refs, nothing summarized away.
//
//  Depth is a NAVIGATION state owned by the consuming surface; assembling is
//  pure, so switching depth re-reads nothing and can never lose focus.
// ============================================================================

import { toolFamilyFor, toolMarkFor } from '../../components/mercury-ui/toolGlyphs.js'
import {
  readReviewArtifactJournal,
  readReviewArtifactState,
} from '../../utils/artifacts/reviewStore.js'
import {
  reviewScopeKey,
  type ReviewArtifactKind,
  type ReviewArtifactStatus,
  type WalkthroughClaim,
} from '../../utils/artifacts/reviewContracts.js'
import { receiptsFor } from '../changeTransaction/receipts.js'
import { evidenceFor } from '../primitives/evidencePlane.js'
import type { OwnerKey } from '../run/ownerKey.js'

export interface FolioGlance {
  ref: string
  kind: ReviewArtifactKind
  title: string
  status: ReviewArtifactStatus
  /** Observed mutation span backing the artifact (first receipt start → last
   *  receipt completion), null when no receipt backs it. */
  elapsedMs: number | null
  changedFileCount: number
  /** e.g. "3 observed · 1 derived · 2 declared" — origins never blur. */
  checkSummary: string
  openComments: number
}

export interface FolioActionGroup {
  family: string
  mark: string
  count: number
  /** Bounded sample of the paths this family touched (≤4). */
  paths: string[]
}

export interface FolioCheckRow {
  claim: string
  origin: 'observed' | 'derived' | 'declared'
  state: string
  refs: string[]
}

export interface FolioCommentRow {
  id: string
  author: string
  excerpt: string
  state: 'open' | 'resolved' | 'outdated'
  /** Anchor rendered for the operator (path:line for diff anchors). */
  where: string
  /** M7 thread lineage — the parent comment this row replies to. */
  parent?: string
}

export interface FolioInspect {
  changedFiles: string[]
  groupedActions: FolioActionGroup[]
  checks: FolioCheckRow[]
  comments: { open: number; resolved: number; outdated: number }
  commentList: FolioCommentRow[]
  visualRefs: string[]
  claims: WalkthroughClaim[]
}

export interface FolioAuditEntry {
  at: number
  line: string
}

export interface FolioAudit {
  chronology: FolioAuditEntry[]
  rawRefs: string[]
}

export interface EvidenceFolio {
  artifactId: string
  /** The version whose body these rows RENDER — decision verbs bind here
   *  (a revision landing after assembly refuses honestly at the store
   *  instead of silently deciding a body the operator never saw — wave B). */
  version: number
  glance: FolioGlance
  inspect: FolioInspect
  audit: FolioAudit
}

/** Accepts a bare artifact id or a mercury://artifact/<id>[/comments] ref. */
export function folioArtifactId(ref: string): string {
  const m = /^mercury:\/\/artifact\/([^/]+)/.exec(ref)
  return m ? m[1]! : ref
}

export function assembleFolio(ref: string, owner: OwnerKey): EvidenceFolio | null {
  const id = folioArtifactId(ref)
  const state = readReviewArtifactState(id)
  if (!state) return null
  const latest = state.versions.find(v => v.version === state.latestVersion)
  if (!latest) return null

  // ── observed mutations: the receipts backing this artifact's span ────────
  // Receipts minted up to the latest revision belong to the folio; later
  // receipts are the NEXT piece of work and must not inflate this one.
  const receipts = receiptsFor(owner).filter(r => r.completedAt <= state.updatedAt + 1)
  const changed = new Set<string>()
  for (const r of receipts) for (const p of r.effect.changedPaths) changed.add(p)
  // The diff body names its files even when the receipt ring has rotated.
  if (latest.body.kind === 'diff') for (const f of latest.body.files) changed.add(f.path)

  const spanStart = receipts.length > 0 ? Math.min(...receipts.map(r => r.startedAt)) : null
  const spanEnd = receipts.length > 0 ? Math.max(...receipts.map(r => r.completedAt)) : null

  // ── canonical checks (evidence plane — origins are load-bearing) ─────────
  const checks: FolioCheckRow[] = evidenceFor(owner)
    .filter(e => e.kind === 'check')
    .map(e => ({ claim: e.claim, origin: e.origin, state: e.state, refs: [...e.refs] }))
  const originCount = (o: FolioCheckRow['origin']): number =>
    checks.filter(c => c.origin === o).length
  const checkSummary =
    checks.length === 0
      ? 'no check records'
      : (['observed', 'derived', 'declared'] as const)
          .filter(o => originCount(o) > 0)
          .map(o => `${originCount(o)} ${o}`)
          .join(' · ')

  // ── actions grouped by tool family (the glyph registry's vocabulary) ─────
  const groups = new Map<string, FolioActionGroup>()
  for (const r of receipts) {
    const family = toolFamilyFor(r.toolName)
    const g = groups.get(family) ?? {
      family,
      mark: toolMarkFor(r.toolName).glyph,
      count: 0,
      paths: [],
    }
    g.count += 1
    for (const p of r.effect.changedPaths) {
      if (g.paths.length < 4 && !g.paths.includes(p)) g.paths.push(p)
    }
    groups.set(family, g)
  }

  // ── comments (the review layer's own states) ─────────────────────────────
  const comments = {
    open: state.comments.filter(c => c.state === 'open').length,
    resolved: state.comments.filter(c => c.state === 'resolved').length,
    outdated: state.comments.filter(c => c.state === 'outdated').length,
  }
  const commentList: FolioCommentRow[] = state.comments.map(c => ({
    id: c.id,
    author: c.author,
    excerpt: c.body.slice(0, 80),
    state: c.state,
    where: c.anchor.t === 'diff-line' ? `${c.anchor.path}:${c.anchor.line}` : c.anchor.t,
    ...(c.parentCommentId !== undefined ? { parent: c.parentCommentId } : {}),
  }))

  // ── visuals: capture refs the body itself carries ────────────────────────
  const visualRefs: string[] = []
  if (latest.body.kind === 'visual') {
    for (const c of latest.body.captures) visualRefs.push(c.ref)
  } else if (latest.body.kind === 'journey') {
    for (const s of latest.body.steps) {
      for (const r of [s.beforeRef, s.afterRef]) if (r) visualRefs.push(r)
    }
  }

  const claims: WalkthroughClaim[] =
    latest.body.kind === 'walkthrough' ? (latest.body.claims ?? []) : []

  // ── audit: the complete chronology, time-ordered, nothing dropped ────────
  const chronology: FolioAuditEntry[] = []
  for (const ev of readReviewArtifactJournal(id)) {
    switch (ev.type) {
      case 'version':
        chronology.push({ at: ev.at, line: `v${ev.record.version} ${ev.record.kind} — ${ev.record.title}` })
        break
      case 'status':
        chronology.push({ at: ev.at, line: `status → ${ev.status} (v${ev.version})` })
        break
      case 'comment':
        chronology.push({ at: ev.at, line: `comment by ${ev.comment.author}: ${ev.comment.body.slice(0, 60)}` })
        break
      case 'comment-state':
        chronology.push({ at: ev.at, line: `comment ${ev.commentId.slice(0, 8)} → ${ev.state}` })
        break
      case 'comment-relocated':
        chronology.push({ at: ev.at, line: `comment ${ev.commentId.slice(0, 8)} ${ev.outcome} (v${ev.version})` })
        break
      case 'scope-decision':
        // The M7 per-scope decisions belong to the immutable chronology —
        // the audit depth drops NOTHING (wave B).
        chronology.push({
          at: ev.at,
          line: `scope ${reviewScopeKey(ev.scope)} → ${ev.decision} (v${ev.version})${ev.by ? ` by ${ev.by}` : ''}`,
        })
        break
    }
  }
  for (const r of receipts) {
    chronology.push({
      at: r.completedAt,
      line: `${r.toolName} ${r.intent.operation} — ${r.effect.changedPaths.join(', ') || r.intent.targetPaths.join(', ')}`,
    })
  }
  chronology.sort((a, b) => a.at - b.at)

  const rawRefs = [
    ...latest.evidenceRefs,
    ...state.comments.map(c => c.resolutionRef).filter((r): r is string => r !== undefined),
  ]

  const status = state.statuses[state.latestVersion] ?? 'draft'
  return {
    artifactId: id,
    version: state.latestVersion,
    glance: {
      ref: `mercury://artifact/${id}`,
      kind: state.kind,
      title: state.title,
      status,
      elapsedMs: spanStart !== null && spanEnd !== null ? Math.max(0, spanEnd - spanStart) : null,
      changedFileCount: changed.size,
      checkSummary,
      openComments: comments.open,
    },
    inspect: {
      changedFiles: [...changed].sort(),
      groupedActions: [...groups.values()].sort((a, b) => b.count - a.count),
      checks,
      comments,
      commentList,
      visualRefs,
      claims,
    },
    audit: { chronology, rawRefs },
  }
}
