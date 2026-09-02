#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-git-graph.ts — the local git work graph,
//  observation side. Real disposable repositories:
//    · clean repo · unstaged · staged · mixed · untracked states typed
//      correctly;
//    · bounded diffs with STABLE content-derived hunk ids;
//    · commit metadata + merge-base + worktree inventory;
//    · conflict inventory with three-way bounded heads;
//    · repo-less honesty (unavailable, never a crash or empty lie);
//    · the status digest moves on ANY tree/index change (the stale truth).
// ============================================================================

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const {
  gitStatus,
  gitDiff,
  gitCommitMeta,
  gitMergeBase,
  gitWorktrees,
  gitConflicts,
} = await import('../../src/services/gitGraph/observe.ts')

const root = mkdtempSync(join(tmpdir(), 'builtin-tools-git-'))
function sh(args: string[], cwd = root): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'proof',
      GIT_AUTHOR_EMAIL: 'proof@local',
      GIT_COMMITTER_NAME: 'proof',
      GIT_COMMITTER_EMAIL: 'proof@local',
    },
  })
}

try {
  console.log('── repo-less honesty ──')
  const bare = mkdtempSync(join(tmpdir(), 'builtin-tools-norepo-'))
  const noRepo = gitStatus(bare)
  check('no repo answers unavailable (named)', 'state' in noRepo && noRepo.state === 'unavailable')
  rmSync(bare, { recursive: true, force: true })

  console.log('── clean / unstaged / staged / mixed / untracked ──')
  sh(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(root, 'b.txt'), 'alpha\nbeta\n')
  sh(['add', '.'])
  sh(['commit', '--quiet', '-m', 'seed'])

  const clean = gitStatus(root)
  check('clean repo reads clean', !('state' in clean) && clean.clean && clean.branch === 'main')

  appendFileSync(join(root, 'a.txt'), 'four\n')
  const unstaged = gitStatus(root)
  check(
    'unstaged edit typed (unstaged M, no staged)',
    !('state' in unstaged) &&
      unstaged.files.length === 1 &&
      unstaged.files[0]!.unstaged === 'M' &&
      unstaged.files[0]!.staged === '',
  )

  sh(['add', 'a.txt'])
  const staged = gitStatus(root)
  check(
    'staged edit typed (staged M, no unstaged)',
    !('state' in staged) && staged.files[0]!.staged === 'M' && staged.files[0]!.unstaged === '',
  )

  appendFileSync(join(root, 'a.txt'), 'five\n')
  writeFileSync(join(root, 'new.txt'), 'fresh\n')
  const mixed = gitStatus(root)
  check(
    'mixed (staged+unstaged) + untracked typed',
    !('state' in mixed) &&
      mixed.files.some(f => f.path === 'a.txt' && f.staged === 'M' && f.unstaged === 'M') &&
      mixed.files.some(f => f.path === 'new.txt' && f.kind === 'untracked'),
  )

  console.log('── digest moves on any change ──')
  const d1 = !('state' in mixed) ? mixed.digest : ''
  appendFileSync(join(root, 'b.txt'), 'gamma\n')
  const moved = gitStatus(root)
  check('tree change moves the digest', !('state' in moved) && moved.digest !== d1)

  console.log('── diffs + stable hunk ids ──')
  const diff1 = gitDiff(root, { scope: 'worktree' })
  const diff2 = gitDiff(root, { scope: 'worktree' })
  check('worktree diff parses files + hunks', !('state' in diff1) && diff1.files.length >= 2 && diff1.hunks.length >= 2)
  check(
    'hunk ids are stable across reads',
    !('state' in diff1) && !('state' in diff2) &&
      JSON.stringify(diff1.hunks.map(h => h.id)) === JSON.stringify(diff2.hunks.map(h => h.id)),
  )
  const stagedDiff = gitDiff(root, { scope: 'staged' })
  check('staged diff is the index view', !('state' in stagedDiff) && stagedDiff.files.some(f => f.path === 'a.txt'))

  console.log('── commit meta + merge-base + worktrees ──')
  const head = sh(['rev-parse', 'HEAD']).trim()
  const meta = gitCommitMeta(root, head)
  check('commit meta typed', !('state' in meta) && meta.subject === 'seed' && meta.files.length === 2)
  const commitDiff = gitDiff(root, { scope: 'commit', ref: head })
  check('commit diff bounded + parsed', !('state' in commitDiff) && commitDiff.files.length === 2)
  const base = gitMergeBase(root, 'HEAD', 'HEAD')
  check('merge-base answers', typeof base === 'string' && base === head)
  const wts = gitWorktrees(root)
  check('worktree inventory', Array.isArray(wts) && wts.length === 1 && wts[0]!.isMain)
  const gone = gitCommitMeta(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  check('unknown sha answers unavailable (named)', 'state' in gone)

  console.log('── conflict inventory (real merge conflict) ──')
  sh(['stash', '--include-untracked'])
  sh(['checkout', '--quiet', '-b', 'side'])
  writeFileSync(join(root, 'a.txt'), 'one\nSIDE\nthree\n')
  sh(['commit', '--quiet', '-am', 'side edit'])
  sh(['checkout', '--quiet', 'main'])
  writeFileSync(join(root, 'a.txt'), 'one\nMAIN\nthree\n')
  sh(['commit', '--quiet', '-am', 'main edit'])
  let mergeFailed = false
  try {
    sh(['merge', '--quiet', 'side'])
  } catch {
    mergeFailed = true
  }
  check('merge conflicts as arranged', mergeFailed)
  const conflicts = gitConflicts(root)
  check(
    'conflict inventory with three-way heads',
    Array.isArray(conflicts) &&
      conflicts.length === 1 &&
      conflicts[0]!.path === 'a.txt' &&
      conflicts[0]!.ours.some(l => l.includes('MAIN')) &&
      conflicts[0]!.theirs.some(l => l.includes('SIDE')) &&
      conflicts[0]!.base.some(l => l.includes('two')),
    JSON.stringify(conflicts).slice(0, 200),
  )
  const statusConf = gitStatus(root)
  check('unmerged files typed in status', !('state' in statusConf) && statusConf.files.some(f => f.kind === 'unmerged'))

  // ──: same-file groups via disjoint hunk ids ─────────
  console.log('── SM-08: one file across two commits (disjoint hunks) ──')
  const { preparePlan, applyPlan } = await import('../../src/services/gitGraph/plan.ts')
  const owner = 'proof:sm08' as never
  const root2 = mkdtempSync(join(tmpdir(), 'builtin-tools-sm08-'))
  try {
    sh(['init', '--quiet', '--initial-branch=main'], root2)
    const body = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
    writeFileSync(join(root2, 'split.txt'), body)
    sh(['add', '.'], root2)
    sh(['commit', '--quiet', '-m', 'base'], root2)
    // Two WELL-SEPARATED edits (top + bottom) → two distinct hunks.
    writeFileSync(
      join(root2, 'split.txt'),
      body.replace('line-2', 'line-2-EDITED-TOP').replace('line-28', 'line-28-EDITED-BOTTOM'),
    )
    const diff = gitDiff(root2, { scope: 'worktree' } as never)
    const ids = 'state' in diff ? [] : diff.hunks.filter(h => h.file === 'split.txt').map(h => h.id)
    check('SM-08 fixture yields two distinct hunks', ids.length === 2, JSON.stringify(ids))

    // Full-file in two groups stays refused.
    const fullRefused = preparePlan(owner, root2, [
      { message: 'top', files: ['split.txt'] },
      { message: 'bottom', files: ['split.txt'] },
    ] as never)
    check('SM-08 full-file double appearance refused (every appearance must select hunks)',
      'state' in fullRefused && fullRefused.state === 'refused' && fullRefused.reason.includes('EVERY appearance'), JSON.stringify(fullRefused).slice(0, 140))

    // Overlapping ids refused before commit one.
    const overlapRefused = preparePlan(owner, root2, [
      { message: 'top', files: ['split.txt'], hunks: { 'split.txt': [ids[0]!] } },
      { message: 'bottom', files: ['split.txt'], hunks: { 'split.txt': [ids[0]!, ids[1]!] } },
    ] as never)
    check('SM-08 overlapping hunk ids refused (one hunk, one commit)',
      'state' in overlapRefused && overlapRefused.state === 'refused' && overlapRefused.reason.includes('more than one group'))

    // Stale/bogus id refused before commit one.
    const bogusRefused = preparePlan(owner, root2, [
      { message: 'top', files: ['split.txt'], hunks: { 'split.txt': [ids[0]!] } },
      { message: 'bottom', files: ['split.txt'], hunks: { 'split.txt': ['gh-000000000000'] } },
    ] as never)
    check('SM-08 non-reproducing hunk id refused before commit one',
      'state' in bogusRefused && bogusRefused.state === 'refused' && bogusRefused.reason.includes('do not reproduce'))

    //  provenance-before-staging: Mercury-touched vs external
    // changed files are DISTINGUISHED on the plan.
    writeFileSync(join(root2, 'external.txt'), 'operator wrote this\n')
    const provPlan = preparePlan(
      owner,
      root2,
      [{ message: 'top only', files: ['split.txt'], hunks: { 'split.txt': [ids[0]!] } }] as never,
      new Set([join(root2, 'split.txt')]),
    )
    check('SM-E provenance: Mercury-touched file marked mercury, external marked external',
      !('reason' in provPlan) && (provPlan as { provenance?: Record<string, string> }).provenance?.['split.txt'] === 'mercury' && (provPlan as { provenance?: Record<string, string> }).provenance?.['external.txt'] === 'external',
      JSON.stringify((provPlan as { provenance?: unknown }).provenance))
    check('SM-E provenance: the external file stays an EXCLUSION by default',
      !('reason' in provPlan) && (provPlan as { exclusions: string[] }).exclusions.includes('external.txt'))
    rmSync(join(root2, 'external.txt'), { force: true })

    // The legal split: disjoint ids, sequence simulated, TWO commits — each
    // containing exactly its hunk.
    const plan = preparePlan(owner, root2, [
      { message: 'top half', files: ['split.txt'], hunks: { 'split.txt': [ids[0]!] } },
      { message: 'bottom half', files: ['split.txt'], hunks: { 'split.txt': [ids[1]!] } },
    ] as never)
    check('SM-08 disjoint same-file plan is ACCEPTED', !('state' in plan && plan.state === 'refused'), JSON.stringify(plan).slice(0, 120))
    if (!('state' in plan && plan.state === 'refused')) {
      const applied = applyPlan(owner, (plan as { id: string }).id)
      const outcome = applied as { state: string; commitsCreated?: unknown[] }
      check('SM-08 both commits created', outcome.state === 'applied' || (outcome.commitsCreated?.length ?? 0) === 2, JSON.stringify(applied).slice(0, 160))
      const c1 = sh(['show', '--format=', 'HEAD~1'], root2)
      const c2 = sh(['show', '--format=', 'HEAD'], root2)
      check('SM-08 commit 1 carries ONLY the top edit', c1.includes('line-2-EDITED-TOP') && !c1.includes('EDITED-BOTTOM'), c1.slice(0, 120))
      check('SM-08 commit 2 carries ONLY the bottom edit', c2.includes('line-28-EDITED-BOTTOM') && !c2.includes('EDITED-TOP'), c2.slice(0, 120))
      const dirty = sh(['status', '--porcelain'], root2).trim()
      check('SM-08 worktree clean after the split (nothing lost)', dirty === '', dirty)
    }
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'GIT GRAPH: ALL GREEN' : `GIT GRAPH: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
