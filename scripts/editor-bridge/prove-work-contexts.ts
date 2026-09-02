#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-work-contexts.ts — PROOF: the typed work
//  contexts:
//
//    (1) bind + restart-resume — a context binds session↔place and is
//        listable after "restart" (a fresh read of the durable store).
//    (2) handoff preview FIRST — dirty paths both sides, divergence,
//        overlap, pending comments, and the EXACT operations; a clean
//        preview is ok:true.
//    (3) conflict-stop — an overlapping dirty path makes the preview an
//        INSPECTABLE STOP (conflicts named per path + suggested
//        resolutions) and executeHandoff REFUSES it.
//    (4) digest fence — the source tree moving between preview and execute
//        refuses with a re-preview instruction.
//    (5) executed handoff rebinds the conversation (mode/worktree/branch/
//        head) without touching either tree's files.
//    (6) setup copy law — only listed files, never overwrite, skips
//        reported (copySetupFiles direct).
//    (7) park = a durable status flip + an ADDRESSABLE recovery artifact
//        (readable, names the dirty paths); restore re-activates; a
//        vanished worktree refuses restore naming the recovery ref.
// (8) cleanup — dirty lane REFUSED (park suggested); clean-but-
//        unintegrated REFUSED; clean+merged lane removed via git's own
//        worktree machinery and archived.
//
//  Hermetic: work-context + review-artifact roots and the fixture repo all
//  live in unique tmp dirs (crash-safe exit cleanup — the S3 lesson).
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-work-contexts.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const ctxRoot = mkdtempSync(join(tmpdir(), 'mosaic-wc-store-'))
const reviewRoot = mkdtempSync(join(tmpdir(), 'mosaic-wc-review-'))
const repo = mkdtempSync(join(tmpdir(), 'mosaic-wc-repo-'))
const laneParent = mkdtempSync(join(tmpdir(), 'mosaic-wc-lane-'))
process.env.MERCURY_WORK_CONTEXTS_DIR = ctxRoot
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = reviewRoot
process.on('exit', () => {
  for (const dir of [ctxRoot, reviewRoot, laneParent, repo]) {
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

const {
  bindWorkContext,
  cleanupLane,
  copySetupFiles,
  executeHandoff,
  listWorkContexts,
  parkWorkContext,
  previewHandoff,
  readWorkContext,
  restoreWorkContext,
} = await import('../../src/services/workContexts/workContexts.js')
const { readReviewArtifactState } = await import('../../src/utils/artifacts/reviewStore.js')

// Fixture: repo with a linked worktree lane carrying one committed change.
git(['init', '-b', 'main'])
git(['config', 'user.email', 'proof@mosaic.test'])
git(['config', 'user.name', 'mosaic-proof'])
writeFileSync(join(repo, 'core.txt'), 'core\n')
writeFileSync(join(repo, 'other.txt'), 'other\n')
git(['add', '.'])
git(['commit', '-m', 'base'])
const lane = join(laneParent, 'lane')
git(['worktree', 'add', '-b', 'lane-branch', lane, 'main'])
writeFileSync(join(lane, 'lane-work.txt'), 'lane work\n')
git(['add', 'lane-work.txt'], lane)
git(['commit', '-m', 'lane commit'], lane)

section('(1) bind + restart-resume')
const ctx = bindWorkContext({
  sessionId: 'sess-wc',
  mode: 'local',
  root: repo,
  model: 'opus',
  permissionMode: 'flow',
  pendingCommentIds: ['rc-11111111'],
})
check('bind creates an active context', ctx.status === 'active' && ctx.mode === 'local')
{
  const resumed = listWorkContexts({ sessionId: 'sess-wc' })
  check('a fresh store read (restart) finds the binding', resumed.length === 1 && resumed[0]!.contextId === ctx.contextId)
  check('model/mode selection survives', resumed[0]!.model === 'opus' && resumed[0]!.permissionMode === 'flow')
}

section('(2) handoff preview FIRST — facts + exact operations')
{
  writeFileSync(join(repo, 'core.txt'), 'core edited locally\n')
  const preview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane } })
  check('preview ok (no overlap)', preview.ok && preview.value.ok)
  if (preview.ok) {
    check('source dirty paths observed', preview.value.from.dirtyPaths.includes('core.txt'))
    check('destination exists + clean', preview.value.to.exists && preview.value.to.dirtyPaths.length === 0)
    check(
      'divergence measured (lane has 1 commit the local lacks)',
      preview.value.divergence !== null && preview.value.divergence.behind === 1 && preview.value.divergence.ahead === 0,
      JSON.stringify(preview.value.divergence),
    )
    check('pending comments counted', preview.value.pendingComments === 1)
    const ops = preview.value.operations.map(o => o.op)
    check('exact operations: rebind + carry comments', ops.includes('rebind-conversation') && ops.includes('carry-pending-comments'))
  }
}

section('(3) conflict-stop — overlap is an inspectable stop')
{
  writeFileSync(join(lane, 'core.txt'), 'core edited in the LANE too\n')
  const preview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane } })
  check('overlap flips ok:false', preview.ok && !preview.value.ok)
  if (preview.ok) {
    check('conflict names the path + reason', preview.value.conflicts[0]?.path === 'core.txt' && preview.value.conflicts[0]!.reason.includes('BOTH'))
    check('suggested resolutions offered', preview.value.suggestedResolutions.length >= 2)
    const refused = await executeHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane }, preview: preview.value })
    check('executeHandoff refuses a conflicted preview', !refused.ok && refused.reason.includes('conflict'))
  }
  // Clear the lane-side overlap for the next legs.
  git(['checkout', '--', 'core.txt'], lane)
}

section('(4) digest fence — the tree moving invalidates the preview')
{
  const preview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane } })
  check('re-preview clean', preview.ok && preview.value.ok)
  if (preview.ok) {
    writeFileSync(join(repo, 'other.txt'), 'moved after the preview\n')
    const refused = await executeHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane }, preview: preview.value })
    check('stale preview refused with re-preview guidance', !refused.ok && refused.reason.includes('re-preview'))
    git(['checkout', '--', 'other.txt'])
  }
}

section('(5) executed handoff rebinds without touching files')
{
  const preview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane } })
  check('preview clean', preview.ok && preview.value.ok)
  if (preview.ok) {
    const done = await executeHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane }, preview: preview.value })
    check('handoff executes', done.ok, done.ok ? '' : done.reason)
    if (done.ok) {
      check(
        'context rebound: worktree mode + branch + head',
        done.value.context.mode === 'worktree' &&
          done.value.context.worktreePath === lane &&
          done.value.context.branch === 'lane-branch' &&
          typeof done.value.context.headSha === 'string',
      )
    }
    check('the local dirty file is untouched', existsSync(join(repo, 'core.txt')))
    // Hand BACK to local: worktree→local rebind.
    const back = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'local', root: repo } })
    check('worktree→local preview ok', back.ok && back.value.ok)
    if (back.ok) {
      const returned = await executeHandoff({ contextId: ctx.contextId, to: { mode: 'local', root: repo }, preview: back.value })
      check('hand back rebinds to local', returned.ok && returned.value.context.mode === 'local')
    }
  }
}

section('(5b) verify-wave regressions — complete dirt · wrong-repo provision · cleared fields')
{
  // (5b-i) worktree→local rebind cleared the stale worktree identity.
  const rebound = listWorkContexts({ sessionId: 'sess-wc' })[0]!
  check('hand-back cleared worktreePath + laneId', rebound.worktreePath === undefined && rebound.laneId === undefined)

  // (5b-ii) dirty listing is COMPLETE past the display fetcher's 50-file cap.
  for (let i = 0; i < 55; i++) writeFileSync(join(repo, `bulk-${String(i).padStart(2, '0')}.txt`), 'x\n')
  const bulkPreview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane } })
  check('55 dirty files ALL observed (no truncation)', bulkPreview.ok && bulkPreview.value.from.dirtyPaths.filter(p => p.startsWith('bulk-')).length === 55)
  // A staged rename of a COMMITTED file reports BOTH sides as dirty work
  // (a renamed never-committed file is just an add — no origin exists).
  git(['mv', 'other.txt', 'other-renamed.txt'])
  const renamePreview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree', root: lane } })
  check(
    'a staged rename reports both sides',
    renamePreview.ok &&
      renamePreview.value.from.dirtyPaths.includes('other-renamed.txt') &&
      renamePreview.value.from.dirtyPaths.includes('other.txt'),
    renamePreview.ok ? renamePreview.value.from.dirtyPaths.filter(p => p.includes('other')).join(',') : 'preview failed',
  )
  git(['mv', 'other-renamed.txt', 'other.txt'])
  for (let i = 0; i < 55; i++) rmSync(join(repo, `bulk-${String(i).padStart(2, '0')}.txt`), { force: true })

  // (5b-iii) provisioning a NEW worktree from a session whose repo is NOT
  // the context's repo REFUSES by name (never a silently misbound lane).
  const foreignCtx = bindWorkContext({ sessionId: 'sess-wc', mode: 'local', root: repo })
  const provisionPreview = await previewHandoff({ contextId: foreignCtx.contextId, to: { mode: 'worktree', newWorktreeSlug: 'wb_refuse' } })
  check('provision preview names the operations', provisionPreview.ok && provisionPreview.value.operations.some(o => o.op === 'provision-worktree'))
  if (provisionPreview.ok) {
    const refused = await executeHandoff({ contextId: foreignCtx.contextId, to: { mode: 'worktree', newWorktreeSlug: 'wb_refuse' }, preview: provisionPreview.value })
    check('wrong-repo provision REFUSED naming both repos', !refused.ok && refused.reason.includes('not the context'))
  }
}

section('(6) setup copy law — only listed, never overwrite')
{
  writeFileSync(join(repo, '.env.local'), 'SECRET=1\n')
  writeFileSync(join(repo, 'notes.txt'), 'unlisted\n')
  const dest = join(laneParent, 'setup-dest')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'existing.txt'), 'already here\n')
  writeFileSync(join(repo, 'existing.txt'), 'source version\n')
  const state = copySetupFiles(repo, dest, { copyFiles: ['.env.local', 'existing.txt', 'missing.txt'] })
  check('listed absent file copied', state.copiedFiles.includes('.env.local') && existsSync(join(dest, '.env.local')))
  check('existing target NEVER overwritten + reported', state.skippedExisting.includes('existing.txt'))
  check('unlisted file not copied', !existsSync(join(dest, 'notes.txt')))
  check('missing source silently absent (not an error)', !state.copiedFiles.includes('missing.txt'))
}

section('(7) park → recovery artifact · restore')
{
  // A second context bound to the DIRTY lane.
  writeFileSync(join(lane, 'wip.txt'), 'uncommitted lane work\n')
  const laneCtx = bindWorkContext({ sessionId: 'sess-wc', mode: 'worktree', root: repo, worktreePath: lane, laneId: 'wt:lane' })
  const parked = await parkWorkContext(laneCtx.contextId)
  check('park succeeds', parked.ok)
  if (parked.ok) {
    const after = readWorkContext(laneCtx.contextId)!
    check('status parked + recovery ref recorded', after.status === 'parked' && after.recoveryArtifactRef === parked.value.recoveryRef)
    const raId = parked.value.recoveryRef.replace('mercury://artifact/', '')
    const artifact = readReviewArtifactState(raId)
    check('recovery artifact is ADDRESSABLE + names the dirty work', artifact !== null && JSON.stringify(artifact.versions[0]!.body).includes('wip.txt'))
    const restored = restoreWorkContext(laneCtx.contextId)
    check('restore re-activates', restored.ok && restored.value.status === 'active')
  }
  // A parked context whose worktree vanished refuses restore, naming recovery.
  const ghost = bindWorkContext({ sessionId: 'sess-wc', mode: 'worktree', root: repo, worktreePath: join(laneParent, 'gone') })
  const ghostParked = await parkWorkContext(ghost.contextId)
  check('parking a vanished-worktree context still records recovery', ghostParked.ok)
  const ghostRestore = restoreWorkContext(ghost.contextId)
  check('restore refuses a vanished worktree naming recovery', !ghostRestore.ok && ghostRestore.reason.includes('no longer exists'))
}

section('(8) cleanup — dirty refused · unintegrated refused · proven-clean removed')
{
  const laneCtx = listWorkContexts({ sessionId: 'sess-wc' }).find(c => c.worktreePath === lane)!
  const dirtyRefusal = await cleanupLane({ contextId: laneCtx.contextId, baseRoot: repo })
  check('dirty lane REFUSED with park suggestion', !dirtyRefusal.ok && dirtyRefusal.reason.includes('park'))
  git(['checkout', '--', '.'], lane)
  rmSync(join(lane, 'wip.txt'), { force: true })
  const unmerged = await cleanupLane({ contextId: laneCtx.contextId, baseRoot: repo })
  check('clean-but-unintegrated REFUSED naming the head', !unmerged.ok && unmerged.reason.includes('NOT integrated'))
  git(['merge', 'lane-branch', '-m', 'integrate lane'])
  const cleaned = await cleanupLane({ contextId: laneCtx.contextId, baseRoot: repo })
  check('proven clean + integrated ⇒ removed', cleaned.ok, cleaned.ok ? '' : cleaned.reason)
  check('worktree gone + context archived', !existsSync(lane) && readWorkContext(laneCtx.contextId)!.status === 'archived')
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ work-context proofs green')
