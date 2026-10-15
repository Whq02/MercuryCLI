#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), 'rv-anchor-honesty-'))

const store = await import('../../src/utils/artifacts/reviewStore.ts')
const { listMdBlocks } = await import('../../src/utils/artifacts/anchors.ts')

const mk = (title: string, md: string): string => {
  const r = store.createReviewArtifact({
    kind: 'plan',
    title,
    producer: { sessionId: 'someone-else' },
    workspace: { roots: [process.cwd()] },
    body: { kind: 'plan', markdown: md },
    initialStatus: 'ready-for-review',
  })
  if (!r.ok) throw new Error(r.reason)
  return r.value.id
}

t.section('§1 — anchor honesty across a revision (RV-25, live): an md-block comment RELOCATES or reads OUTDATED, never a silent wrong anchor')
{
  const md1 = '# plan\n\nalpha block\n\n## tail\n\nbeta block'
  const id = mk('anchor me', md1)
  const blocks = listMdBlocks(md1)
  const surviving = blocks.find(b => b.text === '# plan')!
  const vanishing = blocks.find(b => /beta/.test(b.text))!
  const cKeep = store.addReviewComment({
    artifactId: id,
    version: 1,
    anchor: { t: 'md-block', headingPath: surviving.headingPath, blockDigest: surviving.digest, ordinal: 0 },
    author: 'op',
    body: 'anchored to the surviving heading block',
  })
  const cGone = store.addReviewComment({
    artifactId: id,
    version: 1,
    anchor: { t: 'md-block', headingPath: vanishing.headingPath, blockDigest: vanishing.digest, ordinal: 0 },
    author: 'op',
    body: 'anchored to the vanishing block',
  })
  t.check('(rig) both md-block comments landed', cKeep.ok === true && cGone.ok === true)
  const rev = store.reviseReviewArtifact({
    id,
    body: { kind: 'plan', markdown: '# plan\n\nREWRITTEN ENTIRELY\n\nnothing survives' },
    producer: { sessionId: 'someone-else' },
    workspace: { roots: [process.cwd()] },
  })
  t.check('(rig) v2 landed', rev.ok === true)
  const state = store.readReviewArtifactState(id)!
  const kept = state.comments.find(c => c.body === 'anchored to the surviving heading block')!
  const gone = state.comments.find(c => c.body === 'anchored to the vanishing block')!
  t.check(
    'the surviving-content comment RELOCATED (version moved, state open)',
    kept.state === 'open' && kept.version === 2,
    `state=${kept.state} v=${kept.version}`,
  )
  t.check(
    'the vanished-content comment reads OUTDATED — never a silent wrong anchor',
    gone.state === 'outdated',
    `state=${gone.state} v=${gone.version}`,
  )
}

t.finish('prove-review-anchor-honesty')
