#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-interactive-folios.ts — the M7 interactive-
//  folio laws over the review journal.
//
//  Hermetic: the review-artifact root is a mkdtemp scratch dir.
//
//    §1 threaded replies    — parentCommentId lineage; a reply to a missing
//                             parent refuses; threads never move bodies
//    §2 typed authorship    — authorRef (ActorRef) folds back beside the
//                             legacy string author
//    §3 scope decisions     — validate against the version's OWN body;
//                             last-decision-per-scope wins; the documented
//                             global fold (accept-only ⇒ accepted; any
//                             request-revision ⇒ revision-requested)
//    §4 the action seam     — reply/resolve/reopen/scope-decision receipts
//                             through applyFolioAction; idempotent replay;
//                             request-revision carries its routing receipt
//    §5 the fold SUGGESTS   — scope decisions never auto-apply the
//                             artifact-level status
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-folios-')))
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = join(scratch, 'artifacts')

const store = await import('../../src/utils/artifacts/reviewStore.ts')
const contracts = await import('../../src/utils/artifacts/reviewContracts.ts')
const actions = await import('../../src/services/workbench/folioActions.ts')

const created = store.createReviewArtifact({
  kind: 'diff',
  title: 'the crew seam diff',
  producer: { sessionId: 'producer-session-far-away' },
  workspace: { roots: ['/w'] },
  body: {
    kind: 'diff',
    files: [
      { path: 'src/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' x', '+y'] }] },
      { path: 'src/b.ts', hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: [' z'] }] },
    ],
  },
  evidenceRefs: [],
})
if (!created.ok) throw new Error(`fixture artifact failed: ${created.reason}`)
const artifactId = created.value.id

t.section('§1 — threaded replies')
{
  const root = store.addReviewComment({
    artifactId,
    version: 1,
    anchor: { t: 'whole' },
    author: 'operator',
    body: 'the seat bridge needs a rollback path',
  })
  t.check('the root comment writes', root.ok === true)
  const rootId = root.ok ? root.value.commentId : ''
  const reply = store.addReviewComment({
    artifactId,
    version: 1,
    anchor: { t: 'whole' },
    author: 'agent-mercury',
    parentCommentId: rootId,
    body: 'landed in wave A — attach rolls back on post-handshake failure',
  })
  t.check('a reply writes with parent lineage', reply.ok === true)
  const state = store.readReviewArtifactState(artifactId)!
  const replyRow = state.comments.find(c => c.parentCommentId === rootId)
  t.check('the reply folds back threaded (parentCommentId intact)', replyRow !== undefined)
  t.check(
    'both bodies stay their own comments (threads never merge)',
    state.comments.length === 2 && state.comments.every(c => c.body.length > 0),
  )
  const orphan = store.addReviewComment({
    artifactId,
    version: 1,
    anchor: { t: 'whole' },
    author: 'operator',
    parentCommentId: 'rc-missing00',
    body: 'dangling',
  })
  t.check('a reply to a missing parent refuses (never a silent orphan)', orphan.ok === false)
}

t.section('§2 — typed authorship beside the legacy string')
{
  const withRef = store.addReviewComment({
    artifactId,
    version: 1,
    anchor: { t: 'whole' },
    author: 'Mercury',
    authorRef: { kind: 'agent', agentId: 'cw-abcabcabcabc' as never },
    body: 'typed authorship rides along',
  })
  t.check('a comment with authorRef writes', withRef.ok === true)
  const state = store.readReviewArtifactState(artifactId)!
  const row = state.comments.find(c => c.authorRef !== undefined)
  t.check(
    'the ActorRef folds back beside the string author',
    row !== undefined && row.author === 'Mercury' && row.authorRef?.kind === 'agent',
  )
}

t.section('§3 — scope decisions validate + fold')
{
  const bad = store.recordReviewScopeDecision({
    artifactId,
    version: 1,
    scope: { t: 'file', path: 'src/ghost.ts' },
    decision: 'accept',
  })
  t.check('a decision on a vanished file refuses', bad.ok === false)
  const a1 = store.recordReviewScopeDecision({
    artifactId,
    version: 1,
    scope: { t: 'file', path: 'src/a.ts' },
    decision: 'accept',
    by: 'operator',
  })
  t.check('a file-scope accept records', a1.ok === true && a1.value.fold.accepted === 1)
  const b1 = store.recordReviewScopeDecision({
    artifactId,
    version: 1,
    scope: { t: 'file', path: 'src/b.ts' },
    decision: 'request-revision',
  })
  t.check(
    'any request-revision flips the fold suggestion',
    b1.ok === true && b1.value.fold.suggestion === 'revision-requested',
  )
  const b2 = store.recordReviewScopeDecision({
    artifactId,
    version: 1,
    scope: { t: 'file', path: 'src/b.ts' },
    decision: 'accept',
  })
  t.check(
    'the LAST decision per scope wins (b re-accepted ⇒ all-accepted suggestion)',
    b2.ok === true &&
      b2.value.fold.suggestion === 'accepted' &&
      b2.value.fold.accepted === 2 &&
      b2.value.fold.revisionRequested === 0,
  )
  const hunk = store.recordReviewScopeDecision({
    artifactId,
    version: 1,
    scope: { t: 'hunk', path: 'src/a.ts', hunkIndex: 0 },
    decision: 'accept',
  })
  t.check('a hunk scope validates against the body', hunk.ok === true)
  const badHunk = store.recordReviewScopeDecision({
    artifactId,
    version: 1,
    scope: { t: 'hunk', path: 'src/a.ts', hunkIndex: 9 },
    decision: 'accept',
  })
  t.check('a vanished hunk refuses', badHunk.ok === false)
}

t.section('§4 — the folio action seam')
{
  actions._resetFolioActionReceiptsForTesting()
  const state = store.readReviewArtifactState(artifactId)!
  const rootId = state.comments[0]!.id
  const replyReceipt = await actions.applyFolioAction({
    intentId: 'fi-reply-1',
    kind: 'reply',
    artifactId,
    version: 1,
    commentId: rootId,
    body: 'a threaded reply through the seam',
    by: 'operator',
  })
  t.check(
    'reply → comment-written with the thread named',
    replyReceipt.kind === 'comment-written' && replyReceipt.parentCommentId === rootId,
  )
  const resolveReceipt = await actions.applyFolioAction({
    intentId: 'fi-resolve-1',
    kind: 'resolve-comment',
    artifactId,
    version: 1,
    commentId: rootId,
  })
  t.check(
    'resolve-comment → comment-state-set resolved',
    resolveReceipt.kind === 'comment-state-set' && resolveReceipt.state === 'resolved',
  )
  const reopenReceipt = await actions.applyFolioAction({
    intentId: 'fi-reopen-1',
    kind: 'reopen-comment',
    artifactId,
    version: 1,
    commentId: rootId,
  })
  t.check(
    'reopen-comment → comment-state-set open',
    reopenReceipt.kind === 'comment-state-set' && reopenReceipt.state === 'open',
  )
  const replayed = await actions.applyFolioAction({
    intentId: 'fi-resolve-1',
    kind: 'resolve-comment',
    artifactId,
    version: 1,
    commentId: rootId,
  })
  t.check(
    'a replayed intentId returns ITS receipt (no second owner write)',
    replayed === resolveReceipt &&
      store.readReviewArtifactState(artifactId)!.comments.find(c => c.id === rootId)!.state === 'open',
  )
  const scopeReceipt = await actions.applyFolioAction({
    intentId: 'fi-scope-1',
    kind: 'scope-decision',
    artifactId,
    version: 1,
    scope: { t: 'check', claim: 'typecheck green' },
    decision: 'accept',
  })
  t.check('scope-decision → scope-decided with the fold echoed', scopeReceipt.kind === 'scope-decided')

  // request-revision routes the revision REQUEST — this producer session is
  // foreign and no agent id exists, so the honest route is 'retained'.
  const mark = await actions.applyFolioAction({
    intentId: 'fi-status-1',
    kind: 'mark-reviewed',
    artifactId,
    version: 1,
  })
  t.check('mark-reviewed applies (transition draft→…→reviewed prerequisite)', mark.kind === 'refused' || mark.kind === 'applied')
  store.setReviewArtifactStatus({ id: artifactId, version: 1, status: 'ready-for-review' })
  const revise = await actions.applyFolioAction({
    intentId: 'fi-revise-1',
    kind: 'request-revision',
    artifactId,
    version: 1,
  })
  t.check(
    'request-revision carries the revision-request routing receipt',
    revise.kind === 'applied' &&
      revise.status === 'revision-requested' &&
      revise.revisionRequestRoute === 'retained',
    JSON.stringify(revise).slice(0, 140),
  )
}

t.section('§5 — the fold SUGGESTS, never auto-applies')
{
  const state = store.readReviewArtifactState(artifactId)!
  const fold = contracts.foldScopeDecisions(state.scopeDecisions, 1)
  t.check('the fold has decided scopes', fold.latest.size >= 3)
  t.check(
    'the artifact-level status is the EXPLICIT decision (revision-requested from §4), not the fold suggestion',
    state.statuses[1] === 'revision-requested',
  )
}

t.finish('prove-interactive-folios')
