#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-git-plans.ts — previewed atomic commit
//  transactions. Real disposable repositories:
//    · plan prepare validates: only really-changed files, no file in two
//      groups, exclusions + ambiguous named, digest pinned;
//    · plan COMMITS NOTHING;
//    · two independent groups → two commits, each containing EXACTLY its
//      planned files (verified from the created commits);
//    · dependency order preserved;
//    · partial-hunk planning: one hunk committed, the other stays in the
//      worktree;
//    · changed-tree stale refusal (nothing committed);
//    · no accidental file inclusion (exclusions survive uncommitted,
//      content byte-identical);
//    · one settled evidence-backed plane transaction per created commit;
//    · resulting commits inspectable through mercury://git/commit/<sha>;
//    · stage/restore round-trip (working copy untouched);
//    · conflict resolution (ours) stages the resolution;
//    · cancellation before applying commits nothing.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { gitStatus, gitDiff } = await import('../../src/services/gitGraph/observe.ts')
const {
  preparePlan,
  applyPlan,
  getPlan,
  stageSelection,
  restoreStaged,
  resolveConflict,
  verifyPlan,
  _resetGitPlanStoreForTesting,
} = await import('../../src/services/gitGraph/plan.ts')
const { transactionById } = await import('../../src/services/primitives/transactionPlane.ts')
const { resolveResource } = await import('../../src/services/resources/registry.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
// registers the git adapter (the same side-effect seam tools.ts uses)
await import('../../src/services/resources/adapters/git.ts')

const owner = processMainOwner()
const root = mkdtempSync(join(tmpdir(), 'builtin-tools-plans-'))
function sh(args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
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
  sh(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'core.ts'), 'export const core = 1\n')
  writeFileSync(join(root, 'docs.md'), '# docs\n')
  writeFileSync(join(root, 'hunky.txt'), Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') + '\n')
  sh(['add', '.'])
  sh(['commit', '--quiet', '-m', 'seed'])

  console.log('── prepare validation ──')
  appendFileSync(join(root, 'core.ts'), 'export const extra = 2\n')
  appendFileSync(join(root, 'docs.md'), 'more docs\n')
  writeFileSync(join(root, 'leftover.txt'), 'stays uncommitted\n')

  const badFile = preparePlan(owner, root, [{ files: ['nope.ts'], message: 'x' }])
  check('unchanged file refused', 'reason' in badFile)
  const dupe = preparePlan(owner, root, [
    { files: ['core.ts'], message: 'a' },
    { files: ['core.ts'], message: 'b' },
  ])
  check('a file in two groups refused', 'reason' in dupe)
  const noMsg = preparePlan(owner, root, [{ files: ['core.ts'], message: '  ' }])
  check('empty message refused', 'reason' in noMsg)

  console.log('── two independent groups → two exact commits ──')
  const plan = preparePlan(owner, root, [
    { files: ['core.ts'], message: 'feat: core extra' },
    { files: ['docs.md'], message: 'docs: more', checks: ['docs render'] },
  ])
  if ('reason' in plan) throw new Error(plan.reason)
  check('plan proposed, digest pinned', plan.state === 'proposed' && plan.digest.length === 16)
  check('exclusions named (leftover stays)', plan.exclusions.includes('leftover.txt'), JSON.stringify(plan.exclusions))
  const preLog = sh(['rev-list', '--count', 'HEAD']).trim()
  check('plan COMMITTED NOTHING', preLog === '1')

  const applied = applyPlan(owner, plan.id)
  check('apply succeeds', applied.state === 'applied', JSON.stringify(applied).slice(0, 200))
  if (applied.state === 'applied') {
    check('two commits created in dependency order', applied.commits.length === 2)
    const c1 = applied.commits[0]!
    const c2 = applied.commits[1]!
    check('commit 1 contains EXACTLY core.ts', JSON.stringify(c1.files) === JSON.stringify(['core.ts']))
    check('commit 2 contains EXACTLY docs.md', JSON.stringify(c2.files) === JSON.stringify(['docs.md']))
    check(
      'order preserved (core first, docs second = HEAD)',
      sh(['rev-parse', 'HEAD']).trim() === c2.sha && sh(['rev-parse', 'HEAD~1']).trim() === c1.sha,
    )
    check(
      'no accidental inclusion: leftover.txt survives uncommitted, byte-identical',
      readFileSync(join(root, 'leftover.txt'), 'utf8') === 'stays uncommitted\n' &&
        sh(['status', '--porcelain']).includes('leftover.txt'),
    )
    console.log('── transactions + resources per commit ──')
    for (const c of applied.commits) {
      const txn = transactionById(owner, c.transactionId)
      check(
        `transaction ${c.transactionId} settled with observed effect`,
        txn?.state === 'settled' && txn.effectRef !== undefined && txn.kind === 'git.commit',
        JSON.stringify(txn)?.slice(0, 160),
      )
      const res = await resolveResource(`mercury://git/commit/${c.sha}`, { owner, cwd: root })
      check(
        `mercury://git/commit/${c.sha.slice(0, 8)} resolves`,
        res.state === 'ok' && (res as { resource: { version?: string } }).resource.version === c.sha,
      )
    }
    const planRes = await resolveResource(`mercury://git/plan/${plan.id}`, { owner, cwd: root })
    check('mercury://git/plan/<id> shows the applied chain', planRes.state === 'ok')
  }

  console.log('── stale refusal ──')
  appendFileSync(join(root, 'core.ts'), 'export const later = 3\n')
  const plan2 = preparePlan(owner, root, [{ files: ['core.ts'], message: 'feat: later' }])
  if ('reason' in plan2) throw new Error(plan2.reason)
  appendFileSync(join(root, 'docs.md'), 'drift\n') // the tree changes AFTER prepare
  const preCount = sh(['rev-list', '--count', 'HEAD']).trim()
  const stale = applyPlan(owner, plan2.id)
  check('changed tree REFUSES the plan', stale.state === 'refused' && stale.code === 'stale')
  check('stale refusal committed NOTHING', sh(['rev-list', '--count', 'HEAD']).trim() === preCount)
  check('plan record reads stale', getPlan(owner, plan2.id)?.state === 'stale')
  check('verify names the drift', verifyPlan(owner, root, plan2.id).includes('DRIFTED'))

  // SAME-FILE drift: appending to an already-modified planned file leaves
  // the porcelain status byte-identical — the digest must still move
  // (worktree CONTENT is hashed; the class the artifact leg caught).
  const plan2b = preparePlan(owner, root, [{ files: ['core.ts'], message: 'feat: later take 2' }])
  if ('reason' in plan2b) throw new Error(plan2b.reason)
  appendFileSync(join(root, 'core.ts'), 'export const sameFileDrift = 4\n')
  const stale2 = applyPlan(owner, plan2b.id)
  check(
    'SAME-file content drift REFUSES the plan (content-hashed digest)',
    stale2.state === 'refused' && stale2.code === 'stale',
    JSON.stringify(stale2).slice(0, 160),
  )

  console.log('── partial-hunk planning ──')
  // two separated edits in one file = two hunks; plan commits only the first
  const lines = readFileSync(join(root, 'hunky.txt'), 'utf8').split('\n')
  lines[2] = 'line-2 EDITED-TOP'
  lines[27] = 'line-27 EDITED-BOTTOM'
  writeFileSync(join(root, 'hunky.txt'), lines.join('\n'))
  // absorb the drifted files into one commit so the hunk plan is isolated
  const absorb = preparePlan(owner, root, [
    { files: ['core.ts', 'docs.md', 'leftover.txt'], message: 'chore: absorb' },
  ])
  if ('reason' in absorb) throw new Error(absorb.reason)
  const absorbed = applyPlan(owner, absorb.id)
  check('absorb plan applied', absorbed.state === 'applied')

  const hunkDiff = gitDiff(root, { scope: 'worktree', paths: ['hunky.txt'] })
  if ('state' in hunkDiff) throw new Error(hunkDiff.note)
  check('two hunks present', hunkDiff.hunks.length === 2, `${hunkDiff.hunks.length}`)
  const firstHunk = hunkDiff.hunks[0]!
  const hunkPlan = preparePlan(owner, root, [
    { files: ['hunky.txt'], hunks: { 'hunky.txt': [firstHunk.id] }, message: 'feat: top edit only' },
  ])
  if ('reason' in hunkPlan) throw new Error(hunkPlan.reason)
  const hunkApplied = applyPlan(owner, hunkPlan.id)
  check('hunk plan applied', hunkApplied.state === 'applied', JSON.stringify(hunkApplied).slice(0, 200))
  const committedContent = sh(['show', 'HEAD:hunky.txt'])
  check(
    'committed content has ONLY the planned hunk',
    committedContent.includes('EDITED-TOP') && !committedContent.includes('EDITED-BOTTOM'),
  )
  const worktreeNow = readFileSync(join(root, 'hunky.txt'), 'utf8')
  check(
    'the other hunk SURVIVES in the worktree',
    worktreeNow.includes('EDITED-BOTTOM') && sh(['status', '--porcelain']).includes('hunky.txt'),
  )

  console.log('── stage / restore round-trip ──')
  const staged = stageSelection(root, ['hunky.txt'])
  check('stage exact file', staged.state === 'ok')
  const afterStage = gitStatus(root)
  check('index shows it staged', !('state' in afterStage) && afterStage.files.some(f => f.path === 'hunky.txt' && f.staged === 'M'))
  const restored = restoreStaged(root, ['hunky.txt'])
  check('restore is index-only', restored.state === 'ok')
  const afterRestore = gitStatus(root)
  check(
    'working copy untouched by restore',
    readFileSync(join(root, 'hunky.txt'), 'utf8') === worktreeNow &&
      !('state' in afterRestore) &&
      afterRestore.files.some(f => f.path === 'hunky.txt' && f.unstaged === 'M' && f.staged === ''),
  )

  console.log('── cancellation ──')
  const cancelPlan = preparePlan(owner, root, [{ files: ['hunky.txt'], message: 'never lands' }])
  if ('reason' in cancelPlan) throw new Error(cancelPlan.reason)
  const ac = new AbortController()
  ac.abort()
  const preCancelCount = sh(['rev-list', '--count', 'HEAD']).trim()
  const cancelled = applyPlan(owner, cancelPlan.id, { signal: ac.signal })
  check('cancelled before applying', cancelled.state === 'refused' && cancelled.code === 'cancelled')
  check('cancellation committed nothing', sh(['rev-list', '--count', 'HEAD']).trim() === preCancelCount)

  console.log('── conflict resolution ──')
  sh(['stash', '--include-untracked'])
  sh(['checkout', '--quiet', '-b', 'feature'])
  writeFileSync(join(root, 'docs.md'), '# docs\nFEATURE\n')
  sh(['commit', '--quiet', '-am', 'feature docs'])
  sh(['checkout', '--quiet', 'main'])
  writeFileSync(join(root, 'docs.md'), '# docs\nMAIN\n')
  sh(['commit', '--quiet', '-am', 'main docs'])
  try {
    sh(['merge', '--quiet', 'feature'])
  } catch {
    /* conflict arranged */
  }
  const resolved = resolveConflict(owner, root, 'docs.md', { take: 'ours' })
  check('resolve(ours) succeeds + stages', resolved.state === 'ok', JSON.stringify(resolved).slice(0, 160))
  const afterResolve = gitStatus(root)
  check(
    'conflict cleared from the index',
    !('state' in afterResolve) && !afterResolve.files.some(f => f.kind === 'unmerged'),
  )
  check('ours content won', readFileSync(join(root, 'docs.md'), 'utf8').includes('MAIN'))
} finally {
  rmSync(root, { recursive: true, force: true })
  _resetGitPlanStoreForTesting()
}

console.log(failures === 0 ? 'GIT PLANS: ALL GREEN' : `GIT PLANS: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
