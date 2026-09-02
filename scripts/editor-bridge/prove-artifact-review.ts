#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-artifact-review.ts — PROOF: the immutable
//  versioned review-artifact store + anchored comments:
//
//    (1) immutability — revision appends v2; v1's journal record stays
//        byte-identical; both versions readable; statuses superseded/ready.
//    (2) the status ladder — legal transitions only; 'superseded' never a
//        manual target; illegal transitions refused with the reason named.
//    (3) anchor validation — a comment on a location that does not exist in
//        the version is REFUSED (locations never invented), for every
//        anchor family.
//    (4) relocation law — across a revision: an unambiguous md-block/
//        diff-line anchor relocates; a deleted/ambiguous one reads
//        OUTDATED; vis-region survives only an identical capture;
//        journey-step follows the step id; whole always survives. Every
//        outcome is a recorded journal event (never a silent reattach).
//    (5) torn-tail tolerance — a truncated last journal line loses one
//        record, never the artifact.
//    (6) the mercury://artifact adapter serves head · /v/<n> · /comments,
//        marks older-tree versions STALE, and distinguishes absent forms.
//    (7) the workbench projection surfaces artifact heads + the review
//        queue (open comments · ready-for-review · revision-requested).
//
//  Hermetic: MERCURY_REVIEW_ARTIFACTS_DIR points at a temp dir outside the
//  repo (the ambient-state law).
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-artifact-review.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const root = mkdtempSync(join(tmpdir(), 'mosaic-review-'))
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = root
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const {
  addReviewComment,
  createReviewArtifact,
  readReviewArtifactState,
  reviseReviewArtifact,
  listReviewArtifactHeads,
  setReviewArtifactStatus,
  setReviewCommentState,
} = await import('../../src/utils/artifacts/reviewStore.js')
const { contentDigest, listMdBlocks, listDiffLineSites, validateAnchor } = await import(
  '../../src/utils/artifacts/anchors.js'
)

const producer = { sessionId: 'sess-1', turn: 3 }
const workspace = { roots: ['/repo'], treeDigest: 'tree-v1' }

section('(1) immutability + version chain')
const planV1 = `# The plan\n\nStep one: read the code.\n\nStep two: write the fix.\n`
const created = createReviewArtifact({
  kind: 'plan',
  title: 'fix plan',
  producer,
  workspace,
  body: { kind: 'plan', markdown: planV1 },
  evidenceRefs: ['mercury://run/current'],
  initialStatus: 'ready-for-review',
})
check('create ok', created.ok)
const raId = created.ok ? created.value.id : 'ra-00000000'
{
  const journalBefore = readFileSync(join(root, raId, 'journal.jsonl'), 'utf8')
  const v1Line = journalBefore.split('\n').find(l => l.includes('"version"') && l.includes('"type":"version"'))
  const blocks = listMdBlocks(planV1)
  const stepOne = blocks.find(b => b.text.startsWith('Step one'))!
  const anchored = addReviewComment({
    artifactId: raId,
    version: 1,
    anchor: { t: 'md-block', headingPath: stepOne.headingPath, blockDigest: stepOne.digest, ordinal: 0 },
    author: 'operator',
    body: 'reading alone is not enough — trace the call sites',
  })
  check('anchored comment accepted on a real block', anchored.ok)

  const planV2 = `# The plan\n\nStep one: read the code.\n\nStep two REVISED: write the fix with tests.\n`
  const revised = reviseReviewArtifact({
    id: raId,
    body: { kind: 'plan', markdown: planV2 },
    producer,
    workspace: { roots: ['/repo'], treeDigest: 'tree-v2' },
  })
  check('revise ok', revised.ok)
  check('revision is v2', revised.ok && revised.value.version === 2)
  check(
    'open comment on the unchanged block RELOCATED',
    revised.ok && revised.value.relocation.relocated.length === 1,
  )
  const journalAfter = readFileSync(join(root, raId, 'journal.jsonl'), 'utf8')
  check('v1 journal record byte-identical after revision', v1Line !== undefined && journalAfter.includes(v1Line))
  const state = readReviewArtifactState(raId)!
  check('both versions readable', state.versions.length === 2)
  check('v1 superseded, v2 ready-for-review', state.statuses[1] === 'superseded' && state.statuses[2] === 'ready-for-review')
  check('prior/priorVersion chain', state.versions[1]!.priorVersion === 1)
}

section('(2) the status ladder')
{
  const bad = setReviewArtifactStatus({ id: raId, version: 2, status: 'superseded' })
  check("manual 'superseded' refused", !bad.ok && bad.reason.includes('revision'))
  const reviewed = setReviewArtifactStatus({ id: raId, version: 2, status: 'reviewed' })
  check('ready-for-review → reviewed ok', reviewed.ok)
  const illegal = setReviewArtifactStatus({ id: raId, version: 2, status: 'ready-for-review' })
  check('reviewed → ready-for-review refused with reason', !illegal.ok && illegal.reason.includes('illegal'))
  const accepted = setReviewArtifactStatus({ id: raId, version: 2, status: 'accepted' })
  check('reviewed → accepted ok', accepted.ok)
}

section('(3) anchor validation — locations never invented')
{
  const bogus = addReviewComment({
    artifactId: raId,
    version: 2,
    anchor: { t: 'md-block', headingPath: [], blockDigest: 'feedfeedfeedfeed', ordinal: 0 },
    author: 'operator',
    body: 'this should be refused',
  })
  check('md-block with unknown digest refused', !bogus.ok && bogus.reason.includes('anchor'))

  const diffArtifact = createReviewArtifact({
    kind: 'diff',
    title: 'the change',
    producer,
    workspace,
    body: {
      kind: 'diff',
      files: [
        {
          path: 'src/a.ts',
          hunks: [
            { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' const a = 1', '+const b = 2', ' export {}'] },
          ],
        },
      ],
    },
    initialStatus: 'ready-for-review',
  })
  const diffId = diffArtifact.ok ? diffArtifact.value.id : 'ra-00000000'
  const goodLine = addReviewComment({
    artifactId: diffId,
    version: 1,
    anchor: { t: 'diff-line', path: 'src/a.ts', side: 'new', lineDigest: contentDigest('const b = 2'), hunkIndex: 0, line: 2 },
    author: 'operator',
    body: 'name this better',
  })
  check('diff-line on a real +line accepted', goodLine.ok)
  const wrongLine = addReviewComment({
    artifactId: diffId,
    version: 1,
    anchor: { t: 'diff-line', path: 'src/a.ts', side: 'new', lineDigest: contentDigest('const b = 2'), hunkIndex: 0, line: 9 },
    author: 'operator',
    body: 'wrong line number',
  })
  check('diff-line with wrong line number refused', !wrongLine.ok)

  const vis = createReviewArtifact({
    kind: 'visual',
    title: 'the screen',
    producer,
    workspace,
    body: {
      kind: 'visual',
      captures: [
        { ref: 'mercury://artifact/shots/one', digest: 'cap-1', elements: [{ id: 'submit-btn', label: 'Submit' }] },
      ],
    },
  })
  const visId = vis.ok ? vis.value.id : 'ra-00000000'
  check(
    'vis-elem on a real element accepted',
    addReviewComment({
      artifactId: visId,
      version: 1,
      anchor: { t: 'vis-elem', captureRef: 'mercury://artifact/shots/one', elementId: 'submit-btn' },
      author: 'operator',
      body: 'too small',
    }).ok,
  )
  check(
    'vis-elem on a missing element refused',
    !addReviewComment({
      artifactId: visId,
      version: 1,
      anchor: { t: 'vis-elem', captureRef: 'mercury://artifact/shots/one', elementId: 'nope' },
      author: 'operator',
      body: 'x',
    }).ok,
  )

  // Journey-step validation + region behavior exercised via pure validate.
  const journeyBody = {
    kind: 'journey' as const,
    steps: [{ id: 's1', title: 'open page', result: 'ok' }],
  }
  check('journey-step validates', validateAnchor(journeyBody, { t: 'journey-step', stepId: 's1' }).ok)
  check('journey-step unknown refused', !validateAnchor(journeyBody, { t: 'journey-step', stepId: 's9' }).ok)

  // (3b) diff-line relocation across a revision.
  const rev = reviseReviewArtifact({
    id: diffId,
    body: {
      kind: 'diff',
      files: [
        {
          path: 'src/a.ts',
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 4,
              lines: [' // prelude', ' const a = 1', '+const b = 2', ' export {}'],
            },
          ],
        },
      ],
    },
    producer,
    workspace,
  })
  check('diff revision relocates the surviving line comment', rev.ok && rev.value.relocation.relocated.length === 1)
  const diffState = readReviewArtifactState(diffId)!
  const moved = diffState.comments[0]!
  check('relocated anchor updated to the new line', moved.version === 2 && moved.anchor.t === 'diff-line' && moved.anchor.line === 3)

  const rev2 = reviseReviewArtifact({
    id: diffId,
    body: { kind: 'diff', files: [{ path: 'src/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' export {}'] }] }] },
    producer,
    workspace,
  })
  check('removing the line OUTDATES the comment (recorded)', rev2.ok && rev2.value.relocation.outdated.length === 1)
  const outdated = readReviewArtifactState(diffId)!.comments[0]!
  check('comment reads outdated, anchor unchanged (no silent reattach)', outdated.state === 'outdated' && outdated.anchor.t === 'diff-line' && outdated.anchor.line === 3)
  const resolveOutdated = setReviewCommentState({ artifactId: diffId, commentId: outdated.id, state: 'resolved' })
  check('outdated comment refuses resolve', !resolveOutdated.ok)

  // vis-region: survives identical capture, dies on a changed one.
  const region = addReviewComment({
    artifactId: visId,
    version: 1,
    anchor: { t: 'vis-region', captureRef: 'mercury://artifact/shots/one', captureDigest: 'cap-1', rect: { x: 1, y: 2, w: 10, h: 5 } },
    author: 'operator',
    body: 'this corner is misaligned',
  })
  check('vis-region accepted', region.ok)
  const visRev = reviseReviewArtifact({
    id: visId,
    body: {
      kind: 'visual',
      captures: [{ ref: 'mercury://artifact/shots/two', digest: 'cap-2', elements: [{ id: 'submit-btn' }] }],
    },
    producer,
    workspace,
  })
  const visState = readReviewArtifactState(visId)!
  const regionComment = visState.comments.find(c => c.anchor.t === 'vis-region')!
  const elemComment = visState.comments.find(c => c.anchor.t === 'vis-elem' && c.state !== 'outdated')
  check('changed capture OUTDATES the region comment', visRev.ok && regionComment.state === 'outdated')
  check(
    'element comment follows the element into the new capture',
    elemComment !== undefined &&
      elemComment.anchor.t === 'vis-elem' &&
      elemComment.anchor.captureRef === 'mercury://artifact/shots/two',
  )
}

section('(5) torn-tail tolerance')
{
  const journal = join(root, raId, 'journal.jsonl')
  const before = readReviewArtifactState(raId)!
  const raw = readFileSync(journal, 'utf8')
  writeFileSync(journal, raw + '{"v":1,"at":123,"type":"status","vers', 'utf8')
  const after = readReviewArtifactState(raId)!
  check('torn tail loses one record, never the artifact', after !== null && after.versions.length === before.versions.length)
  const appended = addReviewComment({
    artifactId: raId,
    version: 2,
    anchor: { t: 'whole' },
    author: 'operator',
    body: 'post-torn append works',
  })
  check('append after torn tail repairs with a lead newline', appended.ok)
  const healed = readReviewArtifactState(raId)!
  check('the healed journal folds the new comment', healed.comments.some(c => c.body === 'post-torn append works'))
}

section('(6) the mercury://artifact adapter forms')
{
  const { resolveResource } = await import('../../src/services/resources/registry.js')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.js')
  const ctx = { owner: processMainOwner(), cwd: process.cwd() }

  const head = await resolveResource(`mercury://artifact/${raId}`, ctx)
  check('head resolves ok', head.state === 'ok', head.state !== 'ok' ? head.note : '')
  if (head.state === 'ok') {
    check('head is versioned + lists version children', head.resource.version === 'v2' && (head.resource.children?.length ?? 0) >= 3)
    // Right-tree staleness (verify-wave finding 3): raId's recorded root
    // '/repo' does not exist — the adapter must make NO staleness claim
    // against the READER's unrelated tree.
    check('nonexistent recorded root ⇒ NO staleness claim either way', head.resource.text?.includes('STALE') === false)
    const realRooted = createReviewArtifact({
      kind: 'plan',
      title: 'real-rooted',
      producer,
      workspace: { roots: [process.cwd()], treeDigest: 'definitely-not-this-tree' },
      body: { kind: 'plan', markdown: 'x\n' },
    })
    const realId = realRooted.ok ? realRooted.value.id : 'ra-00000000'
    const realHead = await resolveResource(`mercury://artifact/${realId}`, ctx)
    check(
      'older PRODUCING tree reads STALE (judged against the recorded root)',
      realHead.state === 'ok' && realHead.resource.text?.includes('STALE') === true,
    )
  }
  const v1 = await resolveResource(`mercury://artifact/${raId}/v/1`, ctx)
  check('v1 resolves immutable', v1.state === 'ok' && v1.state === 'ok' && v1.resource.mutable === false)
  const comments = await resolveResource(`mercury://artifact/${raId}/comments`, ctx)
  check('comments thread resolves', comments.state === 'ok')
  const noV = await resolveResource(`mercury://artifact/${raId}/v/9`, ctx)
  check('missing version absent with latest named', noV.state === 'absent' && noV.note.includes('latest'))
  const noArtifact = await resolveResource('mercury://artifact/ra-deadbeef', ctx)
  check('unknown review artifact absent', noArtifact.state === 'absent')
  const legacy = await resolveResource('mercury://artifact/someScope', ctx)
  check('legacy scope listing still resolves', legacy.state === 'ok')
}

section('(7) workbench projection surfaces artifacts + review queue')
{
  const { composeWorkbenchSnapshot } = await import('../../src/services/workbench/selectors.js')
  const heads = listReviewArtifactHeads()
  check('heads listed', heads.length >= 3)
  const inputs = {
    now: Date.now(),
    projectRoot: '/repo',
    sessionId: 'sess-1',
    generation: { treeDigest: 'tree-current' },
    executions: [],
    mainRun: null,
    richTasks: new Map(),
    agentMeta: new Map(),
    laneRuns: new Map(),
    contextLanes: [],
    partySeats: null,
    collab: null,
    workflowsDisk: [],
    crew: null,
    artifacts: heads.map(h => ({
      id: h.id,
      kind: h.kind,
      title: h.title,
      latestVersion: h.latestVersion,
      status: h.status,
      ...(h.treeDigest !== undefined && { treeDigest: h.treeDigest }),
      openComments: h.openComments,
      updatedAt: h.updatedAt,
    })),
    gitWorktreeLanes: [],
  }
  const snap = composeWorkbenchSnapshot(inputs, null)
  check('artifact heads projected', snap.artifactHeads.length === heads.length)
  check('older-tree heads visibly stale', snap.artifactHeads.every(h => h.stale === true))
  check('open comments enqueue review work', snap.reviewQueue.some(r => r.note.includes('open comment')))
  // F6: a ready-for-review head from
  // an OLDER tree no longer enqueues the awaits-review nudge — it stays
  // listed and marked stale (the check above), while HUMAN state (open
  // comments, revision requests) never decays. Retuned from the pre-F6 law
  // that pinned the opposite (a stale walkthrough pinned the derived next
  // action forever — the day-2 wedge).
  check('a STALE ready-for-review head no longer enqueues the nudge', !snap.reviewQueue.some(r => r.note.includes('awaits review')))
  check('next action is the review queue head', snap.nextAction?.startsWith('review:') === true)
  const currentTree = composeWorkbenchSnapshot(
    { ...inputs, artifacts: inputs.artifacts.map(a => ({ ...a, treeDigest: 'tree-current' })) },
    null,
  )
  check('a CURRENT-tree ready-for-review head still enqueues', currentTree.reviewQueue.some(r => r.note.includes('awaits review')))
}

section('(8) verify-wave fixes — fence · ordinal · damaged≠absent · CRLF identity')
{
  // (8a) TWO-PROCESS concurrent revisions: the per-artifact write fence must
  // keep versions dense and receipts truthful (pre-fix: one writer got
  // ok for a revision the fold dropped).
  const raceArt = createReviewArtifact({
    kind: 'plan',
    title: 'race target',
    producer,
    workspace,
    body: { kind: 'plan', markdown: 'race base\n' },
  })
  const raceId = raceArt.ok ? raceArt.value.id : 'ra-00000000'
  const childScript = join(root, 'race-child.ts')
  writeFileSync(
    childScript,
    `
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = ${JSON.stringify(root)}
const { reviseReviewArtifact } = await import(${JSON.stringify(process.cwd() + '/src/utils/artifacts/reviewStore.ts')})
const r = reviseReviewArtifact({
  id: ${JSON.stringify(raceId)},
  body: { kind: 'plan', markdown: 'revised by ' + process.argv[2] + ' at ' + Date.now() + '\\n' },
  producer: { sessionId: 'race-' + process.argv[2] },
  workspace: { roots: ['/repo'] },
})
console.log(JSON.stringify({ ok: r.ok, version: r.ok ? r.value.version : null }))
`,
  )
  const { spawnSync } = await import('node:child_process')
  const bun = process.execPath
  let okCount = 0
  const versions: number[] = []
  const children = ['A', 'B', 'C'].map(tag =>
    spawnSync(bun, ['run', childScript, tag], { encoding: 'utf8', timeout: 30_000 }),
  )
  for (const c of children) {
    try {
      const parsed = JSON.parse(c.stdout.trim().split('\n').pop()!) as { ok: boolean; version: number | null }
      if (parsed.ok) {
        okCount++
        versions.push(parsed.version!)
      }
    } catch {
      /* a crashed child counts as not-ok */
    }
  }
  const after = readReviewArtifactState(raceId)!
  check('every ok receipt corresponds to a REAL folded version', after.latestVersion === 1 + okCount, `latest ${after.latestVersion} vs 1+${okCount}`)
  check('receipt versions are exactly the folded set', JSON.stringify([...versions].sort()) === JSON.stringify(after.versions.slice(1).map(v => v.version).sort()))
  check('versions stay dense under the race', after.versions.map(v => v.version).join(',') === Array.from({ length: after.latestVersion }, (_, i) => i + 1).join(','))

  // (8b) ordinal validation — a negative ordinal is refused, never journaled.
    const badOrdinal = addReviewComment({
    artifactId: raId,
    version: 2,
    anchor: { t: 'md-block', headingPath: [], blockDigest: 'feedfeedfeedfeed', ordinal: -1 },
    author: 'operator',
    body: 'negative ordinal',
  })
  check('negative ordinal refused with the reason named', !badOrdinal.ok && badOrdinal.reason.includes('non-negative'), badOrdinal.ok ? 'was OK' : badOrdinal.reason)

  // (8c) damaged ≠ absent at the adapter.
  const { resolveResource } = await import('../../src/services/resources/registry.js')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.js')
  const ctx = { owner: processMainOwner(), cwd: process.cwd() }
  const damagedArt = createReviewArtifact({
    kind: 'plan',
    title: 'to damage',
    producer,
    workspace,
    body: { kind: 'plan', markdown: 'x\n' },
  })
  const damagedId = damagedArt.ok ? damagedArt.value.id : 'ra-00000000'
  writeFileSync(join(root, damagedId, 'journal.jsonl'), '{"torn')
  const damaged = await resolveResource(`mercury://artifact/${damagedId}`, ctx)
  check('damaged journal reads UNAVAILABLE naming the damage', damaged.state === 'unavailable' && damaged.note.includes('damaged'), damaged.state)
  const neverExisted = await resolveResource('mercury://artifact/ra-0dd0face', ctx)
  check('never-existed still reads absent', neverExisted.state === 'absent')

  // (8d) CRLF identity — an EOL-only rewrite relocates instead of outdating.
  const crlfArt = createReviewArtifact({
    kind: 'plan',
    title: 'crlf',
    producer,
    workspace,
    body: { kind: 'plan', markdown: 'alpha line\r\n\r\nbeta line\r\n' },
  })
  const crlfId = crlfArt.ok ? crlfArt.value.id : 'ra-00000000'
  const crlfBlocks = listMdBlocks('alpha line\r\n\r\nbeta line\r\n')
  const beta = crlfBlocks.find(b => b.text.includes('beta'))!
  const crlfComment = addReviewComment({
    artifactId: crlfId,
    version: 1,
    anchor: { t: 'md-block', headingPath: beta.headingPath, blockDigest: beta.digest, ordinal: 0 },
    author: 'operator',
    body: 'anchored on CRLF',
  })
  check('comment lands on the CRLF body', crlfComment.ok)
  const eolRewrite = reviseReviewArtifact({
    id: crlfId,
    body: { kind: 'plan', markdown: 'alpha line\n\nbeta line\n' },
    producer,
    workspace,
  })
  check('EOL-only rewrite RELOCATES (identity survives CRLF↔LF)', eolRewrite.ok && eolRewrite.value.relocation.relocated.length === 1 && eolRewrite.value.relocation.outdated.length === 0)
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ artifact review proofs green')
