#!/usr/bin/env bun

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

t.section('§4 — the fold SUGGESTS, never auto-applies')
{
  const before = store.readReviewArtifactState(artifactId)!
  const fold = contracts.foldScopeDecisions(before.scopeDecisions, 1)
  t.check('the fold has decided scopes', fold.latest.size >= 3)
  t.check('the fold suggests accepted (every latest decision is an accept)', fold.suggestion === 'accepted', String(fold.suggestion))
  t.check('the artifact-level status is still draft — the suggestion applied nothing', (before.statuses[1] ?? 'draft') === 'draft', String(before.statuses[1]))
  const ready = store.setReviewArtifactStatus({ id: artifactId, version: 1, status: 'ready-for-review' })
  t.check('draft → ready-for-review is the one legal step out of draft', ready.ok === true)
  const revise = store.setReviewArtifactStatus({ id: artifactId, version: 1, status: 'revision-requested' })
  t.check('the EXPLICIT decision lands against the fold suggestion', revise.ok === true)
  const after = store.readReviewArtifactState(artifactId)!
  t.check(
    'the artifact-level status is the EXPLICIT decision (revision-requested), not the fold suggestion (accepted)',
    after.statuses[1] === 'revision-requested' && contracts.foldScopeDecisions(after.scopeDecisions, 1).suggestion === 'accepted',
  )
}

t.finish('prove-interactive-folios')
