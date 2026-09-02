// ============================================================================
//  diff/reviewLayer — the /diff workspace's review glue.
//
//  Commenting in /diff binds the CURRENT source to ONE diff review artifact
//  (created on first comment, reused after — the source key is the binding).
//  Anchors are hunk-granular via the hunk's first changed line
//  (content-derived diff-line identity, so they relocate/outdate honestly
//  across revisions). "Send" re-enters Mercury through the EXISTING command
//  queue — a bounded review turn carrying the comment texts + the
//  mercury://artifact refs, never a second permission mechanism.
// ============================================================================

import type { StructuredPatchHunk } from 'diff'
import { randomUUID } from 'node:crypto'
import { enqueue } from '../../input-core/command-queue.js'
import { contentDigest } from '../../utils/artifacts/anchors.js'
import type {
  DiffBodyFile,
  ReviewAnchor,
  ReviewArtifactState,
  ReviewComment,
} from '../../utils/artifacts/reviewContracts.js'
import {
  addReviewComment,
  createReviewArtifact,
  readReviewArtifactState,
  reviseReviewArtifact,
  setReviewCommentState,
} from '../../utils/artifacts/reviewStore.js'
import { computeWorkingTreeDigestAsync } from '../../utils/verification/verificationState.js'
import { getCwd } from '../../utils/cwd.js'
import type { DiffData } from '../../hooks/useDiffData.js'

// ── anchor building (hunk-granular; first changed line) ─────────────────────

export function buildAnchorForHunk(
  path: string,
  hunk: StructuredPatchHunk,
  hunkIndex: number,
): ReviewAnchor | null {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  let firstContext: ReviewAnchor | null = null
  for (const raw of hunk.lines) {
    const marker = raw[0] ?? ' '
    const content = raw.slice(1)
    if (marker === '+') {
      return {
        t: 'diff-line',
        path,
        side: 'new',
        lineDigest: contentDigest(content),
        hunkIndex,
        line: newLine,
      }
    }
    if (marker === '-') {
      return {
        t: 'diff-line',
        path,
        side: 'old',
        lineDigest: contentDigest(content),
        hunkIndex,
        line: oldLine,
      }
    }
    if (firstContext === null) {
      firstContext = {
        t: 'diff-line',
        path,
        side: 'new',
        lineDigest: contentDigest(content),
        hunkIndex,
        line: newLine,
      }
    }
    if (marker === '-' || marker === ' ') oldLine++
    if (marker === '+' || marker === ' ') newLine++
  }
  return firstContext
}

// ── source ↔ artifact binding (session-lifetime) ────────────────────────────

const sourceArtifacts = new Map<string, string>()

export function diffDataToBodyFiles(diffData: DiffData): DiffBodyFile[] {
  const files: DiffBodyFile[] = []
  for (const f of diffData.files) {
    const hunks = diffData.hunks.get(f.path)
    if (!hunks || hunks.length === 0) continue
    files.push({
      path: f.path,
      hunks: hunks.map(h => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: [...h.lines],
      })),
    })
  }
  return files
}

function boundKey(sourceKey: string): string {
  // Bindings are PROJECT-scoped: after an in-process cwd switch the same
  // sourceKey must never resolve another project's artifact (verify wave,
  // UI finding 3d).
  return `${getCwd()}::${sourceKey}`
}

export async function ensureDiffArtifact(args: {
  sourceKey: string
  label: string
  diffData: DiffData
  sessionId: string
}): Promise<{ ok: true; artifactId: string } | { ok: false; reason: string }> {
  const existing = sourceArtifacts.get(boundKey(args.sourceKey))
  if (existing && readReviewArtifactState(existing)) {
    return { ok: true, artifactId: existing }
  }
  const files = diffDataToBodyFiles(args.diffData)
  if (files.length === 0) {
    return { ok: false, reason: 'nothing to review — this source has no hunks' }
  }
  // ASYNC digest — the sync variant hashes the whole tree on the event loop
  // inside a keypress handler.
  let treeDigest: string | null = null
  try {
    treeDigest = await computeWorkingTreeDigestAsync(getCwd())
  } catch {
    treeDigest = null
  }
  const created = createReviewArtifact({
    kind: 'diff',
    title: args.label,
    producer: { sessionId: args.sessionId },
    workspace: { roots: [getCwd()], ...(treeDigest !== null && { treeDigest }) },
    body: { kind: 'diff', files },
    initialStatus: 'ready-for-review',
  })
  if (!created.ok) return { ok: false, reason: created.reason }
  sourceArtifacts.set(boundKey(args.sourceKey), created.value.id)
  return { ok: true, artifactId: created.value.id }
}

export function boundArtifactId(sourceKey: string): string | null {
  const id = sourceArtifacts.get(boundKey(sourceKey))
  return id && readReviewArtifactState(id) ? id : null
}

/** TEST-ONLY: reset the binding map between prover scenarios. */
export function _resetReviewLayerForTesting(): void {
  sourceArtifacts.clear()
}

// ── comment lookup for rendering ────────────────────────────────────────────

export interface FileReviewMarks {
  /** hunkIndex → comments anchored to the LATEST stored version — indices
   *  from older versions must never decorate the live hunks (verify wave,
   *  UI finding 6). */
  byHunk: Map<number, ReviewComment[]>
  open: number
  resolved: number
  outdated: number
  /** Open comments anchored to OLDER stored versions (shown as a count,
   *  never as live hunk marks). */
  olderVersion: number
}

export function reviewMarksForFile(artifactId: string | null, path: string): FileReviewMarks {
  const marks: FileReviewMarks = {
    byHunk: new Map(),
    open: 0,
    resolved: 0,
    outdated: 0,
    olderVersion: 0,
  }
  if (!artifactId) return marks
  const state = readReviewArtifactState(artifactId)
  if (!state) return marks
  for (const c of state.comments) {
    if (c.anchor.t !== 'diff-line' || c.anchor.path !== path) continue
    if (c.version !== state.latestVersion) {
      if (c.state === 'open') marks.olderVersion++
      continue
    }
    const list = marks.byHunk.get(c.anchor.hunkIndex) ?? []
    list.push(c)
    marks.byHunk.set(c.anchor.hunkIndex, list)
    if (c.state === 'open') marks.open++
    else if (c.state === 'resolved') marks.resolved++
    else marks.outdated++
  }
  return marks
}

export function artifactReviewCounts(artifactId: string | null): {
  open: number
  resolved: number
  outdated: number
} {
  const counts = { open: 0, resolved: 0, outdated: 0 }
  if (!artifactId) return counts
  const state = readReviewArtifactState(artifactId)
  if (!state) return counts
  for (const c of state.comments) {
    if (c.state === 'open') counts.open++
    else if (c.state === 'resolved') counts.resolved++
    else counts.outdated++
  }
  return counts
}

// ── comment actions ─────────────────────────────────────────────────────────

export function annotateHunk(args: {
  artifactId: string
  path: string
  hunk: StructuredPatchHunk
  hunkIndex: number
  body: string
  author?: string
  /** The CURRENT source diff — when the stored body drifted, a fresh
   *  version is appended (relocating existing comments) and the annotate
   *  retries against it, instead of a dead-end refusal. */
  currentDiffData?: DiffData
  producerSessionId?: string
}): { ok: true; commentId: string } | { ok: false; reason: string } {
  const state = readReviewArtifactState(args.artifactId)
  if (!state) return { ok: false, reason: `no review artifact '${args.artifactId}'` }
  const anchor = buildAnchorForHunk(args.path, args.hunk, args.hunkIndex)
  if (!anchor) return { ok: false, reason: 'this hunk has no addressable line' }
  const added = addReviewComment({
    artifactId: args.artifactId,
    version: state.latestVersion,
    anchor,
    author: args.author ?? 'operator',
    body: args.body,
  })
  if (added.ok) return { ok: true, commentId: added.value.commentId }
  // The live tree drifted past the stored body: append the CURRENT diff as
  // a new version (the honest revision path — existing comments relocate or
  // read OUTDATED) and retry once.
  if (args.currentDiffData && added.reason.includes('anchor does not validate')) {
    const files = diffDataToBodyFiles(args.currentDiffData)
    if (files.length > 0) {
      const revised = reviseReviewArtifact({
        id: args.artifactId,
        body: { kind: 'diff', files },
        producer: { sessionId: args.producerSessionId ?? 'unknown-session' },
        workspace: { roots: [getCwd()] },
      })
      if (revised.ok) {
        const retry = addReviewComment({
          artifactId: args.artifactId,
          version: revised.value.version,
          anchor,
          author: args.author ?? 'operator',
          body: args.body,
        })
        if (retry.ok) return { ok: true, commentId: retry.value.commentId }
        return retry
      }
    }
  }
  return added
}

export function resolveHunkComments(args: {
  artifactId: string
  path: string
  hunkIndex: number
}): number {
  const marks = reviewMarksForFile(args.artifactId, args.path)
  const comments = marks.byHunk.get(args.hunkIndex) ?? []
  let n = 0
  for (const c of comments) {
    if (c.state !== 'open') continue
    const done = setReviewCommentState({
      artifactId: args.artifactId,
      commentId: c.id,
      state: 'resolved',
    })
    if (done.ok) n++
  }
  return n
}

// ── send (through the EXISTING command queue) ───────────────────────────────

const SEND_MAX_COMMENTS = 24
const SEND_MAX_BODY = 400

export function buildReviewTurnMessage(
  state: ReviewArtifactState,
  comments: ReviewComment[],
): string {
  const lines: string[] = [
    `Review comments on '${state.title}' (mercury://artifact/${state.id}/comments):`,
  ]
  for (const c of comments.slice(0, SEND_MAX_COMMENTS)) {
    const where =
      c.anchor.t === 'diff-line'
        ? `${c.anchor.path}:${c.anchor.line} (${c.anchor.side})`
        : c.anchor.t
    lines.push(`- [${c.id}] ${where}: ${c.body.slice(0, SEND_MAX_BODY)}`)
  }
  if (comments.length > SEND_MAX_COMMENTS) {
    lines.push(`… ${comments.length - SEND_MAX_COMMENTS} more — read the comments ref above.`)
  }
  lines.push(
    'Address each comment. Inspect the full thread and the anchored diff via the ref; reply naming what changed per comment.',
  )
  return lines.join('\n')
}

export function sendComments(args: {
  artifactId: string
  scope: { kind: 'all-open' } | { kind: 'hunk'; path: string; hunkIndex: number }
}): { ok: true; sent: number } | { ok: false; reason: string } {
  const state = readReviewArtifactState(args.artifactId)
  if (!state) return { ok: false, reason: `no review artifact '${args.artifactId}'` }
  const pool =
    args.scope.kind === 'all-open'
      ? state.comments.filter(c => c.state === 'open')
      : (reviewMarksForFile(args.artifactId, args.scope.path).byHunk.get(args.scope.hunkIndex) ??
          []).filter(c => c.state === 'open')
  if (pool.length === 0) return { ok: false, reason: 'no open comments to send' }
  enqueue({
    value: buildReviewTurnMessage(state, pool),
    mode: 'prompt',
    priority: 'later',
    uuid: randomUUID(),
  })
  return { ok: true, sent: pool.length }
}
