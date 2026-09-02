#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-diff-sources.ts — PROOF: the /diff source
//  model + review layer:
//
//    (1) the parameterized git fetchers — unstaged vs staged vs HEAD vs
//        branch-vs-base vs lane-worktree see the RIGHT file sets, through
//        the same shortstat→numstat→hunks machinery (fixture repo OUTSIDE
//        the tree; spec.cwd is the seam).
//    (2) artifact sources — a stored diff body passes through hunks
//        untouched (no reparsing); a two-version plan artifact renders the
//        version-to-version structuredPatch.
//    (3) the review glue — hunk anchors pick the first changed line
//        (content-derived), ensure-artifact binds a source once, annotate
//        validates, marks group by hunk, and the bounded review-turn
//        message names the artifact ref + every comment.
//    (4) the keybinding tables — the five review actions exist in schema +
//        defaults (a/f/r/s/x in the DiffDialog context).
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-diff-sources.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const reviewRoot = mkdtempSync(join(tmpdir(), 'mosaic-diff-review-'))
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = reviewRoot

const repo = mkdtempSync(join(tmpdir(), 'mosaic-diff-repo-'))
const laneParent = mkdtempSync(join(tmpdir(), 'mosaic-diff-lane-'))
process.on('exit', () => {
  // Crash-safe fixture cleanup — a thrown check must never poison the next run.
  for (const dir of [reviewRoot, repo, laneParent]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})
function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

section('(1) parameterized git fetchers — the right file set per source')
{
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'proof@mosaic.test'])
  git(['config', 'user.name', 'mosaic-proof'])
  writeFileSync(join(repo, 'a.txt'), 'alpha\n')
  writeFileSync(join(repo, 'b.txt'), 'bravo\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])

  // Feature branch with a committed change (branch-vs-base material).
  git(['checkout', '-b', 'feature'])
  writeFileSync(join(repo, 'c.txt'), 'charlie\n')
  git(['add', 'c.txt'])
  git(['commit', '-m', 'feature adds c'])

  // Staged change to a.txt; unstaged change to b.txt.
  writeFileSync(join(repo, 'a.txt'), 'alpha staged\n')
  git(['add', 'a.txt'])
  writeFileSync(join(repo, 'b.txt'), 'bravo unstaged\n')

  const { fetchGitDiffFor, fetchGitDiffHunksFor } = await import('../../src/utils/gitDiff.js')

  const staged = await fetchGitDiffFor({ args: ['--cached'], cwd: repo })
  check('staged sees only a.txt', staged !== null && [...staged.perFileStats.keys()].join() === 'a.txt', JSON.stringify([...(staged?.perFileStats.keys() ?? [])]))

  const unstaged = await fetchGitDiffFor({ args: [], cwd: repo })
  check('unstaged sees only b.txt', unstaged !== null && [...unstaged.perFileStats.keys()].join() === 'b.txt', JSON.stringify([...(unstaged?.perFileStats.keys() ?? [])]))

  const head = await fetchGitDiffFor({ args: ['HEAD'], cwd: repo })
  check(
    'HEAD sees both',
    head !== null && [...head.perFileStats.keys()].sort().join() === 'a.txt,b.txt',
    JSON.stringify([...(head?.perFileStats.keys() ?? [])]),
  )

  const mergeBase = git(['merge-base', 'main', 'HEAD']).trim()
  const branch = await fetchGitDiffFor({ args: [`${mergeBase}...HEAD`], cwd: repo })
  check(
    'branch-vs-base sees only the committed feature change',
    branch !== null && [...branch.perFileStats.keys()].join() === 'c.txt',
    JSON.stringify([...(branch?.perFileStats.keys() ?? [])]),
  )

  const hunks = await fetchGitDiffHunksFor({ args: [], cwd: repo })
  const bHunks = hunks.get('b.txt')
  check('unstaged hunks parse through the ONE parser', bHunks !== undefined && bHunks.length === 1)

  // Lane worktree: a linked worktree with its own dirt (unique parent — a
  // fixed tmp path poisons the NEXT run when a crash skips cleanup).
  const lane = join(laneParent, 'lane')
  git(['worktree', 'add', lane, 'main'])
  writeFileSync(join(lane, 'a.txt'), 'lane change\n')
  const laneDiff = await fetchGitDiffFor({ args: ['HEAD'], cwd: lane })
  check('lane worktree diff sees the lane dirt only', laneDiff !== null && [...laneDiff.perFileStats.keys()].join() === 'a.txt')

  // Verify-wave regressions (UI findings 1/7/8):
  const { sourceGitSpec } = await import('../../src/components/diff/diffSources.js')
  const branchSpec = sourceGitSpec({ type: 'branch', base: 'main', spec: { args: [`${mergeBase}...HEAD`] } })
  check('the branch source CARRIES its merge-base spec (never null)', branchSpec !== null && branchSpec.args[0]!.includes(mergeBase))
  const deadExport = await import('../../src/components/diff/diffSources.js')
  check('resolveBranchSpec dead code removed', !('resolveBranchSpec' in deadExport))

  writeFileSync(join(lane, 'lane-untracked.txt'), 'new in lane\n')
  const laneWithUntracked = await fetchGitDiffFor({ args: ['HEAD'], cwd: lane, includeUntracked: true })
  check(
    'lane diffs include untracked files',
    laneWithUntracked !== null && laneWithUntracked.perFileStats.get('lane-untracked.txt')?.isUntracked === true,
  )

  const laneGitDir = git(['rev-parse', '--git-dir'], lane).trim()
  const mergeHead = join(laneGitDir.startsWith('/') ? laneGitDir : join(lane, laneGitDir), 'MERGE_HEAD')
  writeFileSync(mergeHead, 'deadbeef\n')
  const transient = await fetchGitDiffFor({ args: ['HEAD'], cwd: lane, includeUntracked: true })
  check('a lane mid-merge REFUSES (incoming changes are not lane work)', transient === null)
  rmSync(mergeHead, { force: true })
}

section('(2) artifact diff sources — stored bodies, never reparsed')
{
  const { createReviewArtifact, reviseReviewArtifact } = await import(
    '../../src/utils/artifacts/reviewStore.js'
  )
  const { artifactDiffData } = await import('../../src/components/diff/diffSources.js')

  const storedHunk = {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    lines: [' context', '+added line'],
  }
  const diffArt = createReviewArtifact({
    kind: 'diff',
    title: 'stored change',
    producer: { sessionId: 's' },
    workspace: { roots: ['/repo'] },
    body: { kind: 'diff', files: [{ path: 'x.ts', hunks: [storedHunk] }] },
  })
  const diffId = diffArt.ok ? diffArt.value.id : 'ra-00000000'
  const data = artifactDiffData(diffId)
  check('diff body passes through', data.files.length === 1 && data.hunks.get('x.ts')?.[0]?.lines[1] === '+added line')
  check('stats derived from stored lines', data.stats?.linesAdded === 1 && data.stats?.linesRemoved === 0)

  const planArt = createReviewArtifact({
    kind: 'plan',
    title: 'plan',
    producer: { sessionId: 's' },
    workspace: { roots: ['/repo'] },
    body: { kind: 'plan', markdown: 'line one\nline two\n' },
  })
  const planId = planArt.ok ? planArt.value.id : 'ra-00000000'
  reviseReviewArtifact({
    id: planId,
    body: { kind: 'plan', markdown: 'line one\nline two CHANGED\n' },
    producer: { sessionId: 's' },
    workspace: { roots: ['/repo'] },
  })
  const planData = artifactDiffData(planId)
  const planHunks = [...planData.hunks.values()][0]
  check(
    'plan v1→v2 renders the structuredPatch',
    planData.files.length === 1 &&
      planHunks !== undefined &&
      planHunks.some(h => h.lines.some(l => l === '+line two CHANGED')),
  )
}

section('(3) the review glue')
{
  const { buildAnchorForHunk, diffDataToBodyFiles, ensureDiffArtifact, annotateHunk, reviewMarksForFile, buildReviewTurnMessage, _resetReviewLayerForTesting } =
    await import('../../src/components/diff/reviewLayer.js')
  const { readReviewArtifactState } = await import('../../src/utils/artifacts/reviewStore.js')
  const { contentDigest } = await import('../../src/utils/artifacts/anchors.js')
  _resetReviewLayerForTesting()

  const hunk = {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 4,
    lines: [' before', '+first added', ' middle', '+second added', ' after'],
  }
  const anchor = buildAnchorForHunk('src/y.ts', hunk, 2)
  check(
    'anchor = first changed line, new side, content-derived',
    anchor?.t === 'diff-line' &&
      anchor.side === 'new' &&
      anchor.line === 11 &&
      anchor.lineDigest === contentDigest('first added') &&
      anchor.hunkIndex === 2,
  )
  const removalHunk = { oldStart: 5, oldLines: 2, newStart: 5, newLines: 1, lines: [' keep', '-drop me'] }
  const removalAnchor = buildAnchorForHunk('src/y.ts', removalHunk, 0)
  check('pure-removal hunk anchors the old side', removalAnchor?.t === 'diff-line' && removalAnchor.side === 'old' && removalAnchor.line === 6)

  const diffData = {
    stats: { filesCount: 1, linesAdded: 2, linesRemoved: 0 },
    files: [
      { path: 'src/y.ts', linesAdded: 2, linesRemoved: 0, isBinary: false, isLargeFile: false, isTruncated: false },
    ],
    hunks: new Map([['src/y.ts', [hunk]]]),
    loading: false,
  }
  const bodyFiles = diffDataToBodyFiles(diffData)
  check('body files carry the hunks', bodyFiles.length === 1 && bodyFiles[0]!.hunks.length === 1)

  const ensured = await ensureDiffArtifact({ sourceKey: 'staged', label: 'Staged changes', diffData, sessionId: 'sess-x' })
  check('ensure creates the bound artifact', ensured.ok)
  const artifactId = ensured.ok ? ensured.artifactId : 'ra-00000000'
  const again = await ensureDiffArtifact({ sourceKey: 'staged', label: 'Staged changes', diffData, sessionId: 'sess-x' })
  check('same source binds the SAME artifact', again.ok && again.ok && again.artifactId === artifactId)

  const annotated = annotateHunk({ artifactId, path: 'src/y.ts', hunk, hunkIndex: 0, body: 'why two adds?' })
  check('annotate validates + lands', annotated.ok)
  const marks = reviewMarksForFile(artifactId, 'src/y.ts')
  check('marks group by hunk', marks.byHunk.get(0)?.length === 1 && marks.open === 1)

  const state = readReviewArtifactState(artifactId)!
  const message = buildReviewTurnMessage(state, state.comments)
  check(
    'review-turn message names the ref + the comment',
    message.includes(`mercury://artifact/${artifactId}/comments`) &&
      message.includes('src/y.ts:11 (new)') &&
      message.includes('why two adds?'),
  )
}

section('(4) keybinding tables')
{
  const { KEYBINDING_ACTIONS } = await import('../../src/keybindings/schema.js')
  const actions = KEYBINDING_ACTIONS as readonly string[]
  for (const a of ['diff:annotate', 'diff:nextFinding', 'diff:resolveComments', 'diff:sendComments', 'diff:sendAllComments']) {
    check(`schema has ${a}`, actions.includes(a))
  }
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
  const diffCtx = (DEFAULT_BINDINGS as Array<{ context: string; bindings: Record<string, string> }>).find(
    b => b.context === 'DiffDialog',
  )
  check('defaults map a/f/r/s/x', diffCtx !== undefined && diffCtx.bindings['a'] === 'diff:annotate' && diffCtx.bindings['f'] === 'diff:nextFinding' && diffCtx.bindings['r'] === 'diff:resolveComments' && diffCtx.bindings['s'] === 'diff:sendComments' && diffCtx.bindings['x'] === 'diff:sendAllComments')
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ diff source + review proofs green')
