#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-folios-')))
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = join(scratch, 'artifacts')

const store = await import('../../src/sessions/artifact-reviews/reviewStore.ts')

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

t.finish('prove-interactive-folios')
