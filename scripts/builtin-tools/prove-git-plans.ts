#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { gitStatus, gitDiff } = await import('../../src/platform/git-graph/observe.ts')
const {
  preparePlan,
  applyPlan,
  getPlan,
  stageSelection,
  restoreStaged,
  resolveConflict,
  verifyPlan,
  _resetGitPlanStoreForTesting,
} = await import('../../src/platform/git-graph/plan.ts')
const { transactionById } = await import('../../src/engine/runtime-kernel/transactionPlane.ts')
const { resolveResource } = await import('../../src/integrations/resources/registry.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')

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
  check('unchanged file refused', 'reason' in badFile, 'preparePlan in src/platform/git-graph/plan.ts must return a reason for a file with no change')
  const dupe = preparePlan(owner, root, [
    { files: ['core.ts'], message: 'a' },
    { files: ['core.ts'], message: 'b' },
  ])
  check('a file in two groups refused', 'reason' in dupe, 'preparePlan in src/platform/git-graph/plan.ts must return a reason when one file is in two groups')
  const noMsg = preparePlan(owner, root, [{ files: ['core.ts'], message: '  ' }])
  check('empty message refused', 'reason' in noMsg, 'preparePlan in src/platform/git-graph/plan.ts must return a reason for a blank commit message')

  console.log('── two independent groups → two exact commits ──')
  const plan = preparePlan(owner, root, [
    { files: ['core.ts'], message: 'feat: core extra' },
    { files: ['docs.md'], message: 'docs: more', checks: ['docs render'] },
  ])
  if ('reason' in plan) throw new Error(plan.reason)
  check('plan proposed, digest pinned', plan.state === 'proposed' && plan.digest.length === 16, `${plan.state} digest length ${plan.digest.length}; preparePlan in src/platform/git-graph/plan.ts must return a proposed plan with a 16-character digest`)
  check('exclusions named (leftover stays)', plan.exclusions.includes('leftover.txt'), JSON.stringify(plan.exclusions) + ' — preparePlan in src/platform/git-graph/plan.ts must list every changed file outside the groups in exclusions')
  const preLog = sh(['rev-list', '--count', 'HEAD']).trim()
  check('plan COMMITTED NOTHING', preLog === '1', `commit count ${preLog}; preparePlan in src/platform/git-graph/plan.ts must not run git commit`)

  const applied = applyPlan(owner, plan.id)
  check('apply succeeds', applied.state === 'applied', JSON.stringify(applied).slice(0, 200) + ' — see applyPlan in src/platform/git-graph/plan.ts')
  if (applied.state === 'applied') {
    check('two commits created in dependency order', applied.commits.length === 2, `${applied.commits.length} commits; applyPlan in src/platform/git-graph/plan.ts must make one commit per group`)
    const c1 = applied.commits[0]!
    const c2 = applied.commits[1]!
    check('commit 1 contains EXACTLY core.ts', JSON.stringify(c1.files) === JSON.stringify(['core.ts']), JSON.stringify(c1.files) + ' — applyPlan in src/platform/git-graph/plan.ts must commit only the files of the group')
    check('commit 2 contains EXACTLY docs.md', JSON.stringify(c2.files) === JSON.stringify(['docs.md']), JSON.stringify(c2.files) + ' — applyPlan in src/platform/git-graph/plan.ts must commit only the files of the group')
    check(
      'order preserved (core first, docs second = HEAD)',
      sh(['rev-parse', 'HEAD']).trim() === c2.sha && sh(['rev-parse', 'HEAD~1']).trim() === c1.sha,
      'applyPlan in src/platform/git-graph/plan.ts must commit the groups in plan order',
    )
    check(
      'no accidental inclusion: leftover.txt survives uncommitted, byte-identical',
      readFileSync(join(root, 'leftover.txt'), 'utf8') === 'stays uncommitted\n' &&
        sh(['status', '--porcelain']).includes('leftover.txt'),
      'applyPlan in src/platform/git-graph/plan.ts must stage only the planned files and leave other changes alone',
    )
    console.log('── transactions + resources per commit ──')
    for (const c of applied.commits) {
      const txn = transactionById(owner, c.transactionId)
      check(
        `transaction ${c.transactionId} settled with observed effect`,
        txn?.state === 'settled' && txn.effectRef !== undefined && txn.kind === 'git.commit',
        JSON.stringify(txn)?.slice(0, 160) + ' — applyPlan in src/platform/git-graph/plan.ts must settle one git.commit transaction with an effectRef per commit',
      )
      const res = await resolveResource(`mercury://git/commit/${c.sha}`, { owner, cwd: root })
      check(
        `mercury://git/commit/${c.sha.slice(0, 8)} resolves`,
        res.state === 'ok' && (res as { resource: { version?: string } }).resource.version === c.sha,
        `state ${res.state}; the mercury://git/commit resolver (see resolveResource in src/integrations/resources/registry.ts) must resolve a commit made by applyPlan, with the sha as its version`,
      )
    }
    const planRes = await resolveResource(`mercury://git/plan/${plan.id}`, { owner, cwd: root })
    check('mercury://git/plan/<id> shows the applied chain', planRes.state === 'ok', `state ${planRes.state}; the mercury://git/plan resolver (see resolveResource in src/integrations/resources/registry.ts) must resolve an applied plan`)
  }

  console.log('── stale refusal ──')
  appendFileSync(join(root, 'core.ts'), 'export const later = 3\n')
  const plan2 = preparePlan(owner, root, [{ files: ['core.ts'], message: 'feat: later' }])
  if ('reason' in plan2) throw new Error(plan2.reason)
  appendFileSync(join(root, 'docs.md'), 'drift\n')
  const preCount = sh(['rev-list', '--count', 'HEAD']).trim()
  const stale = applyPlan(owner, plan2.id)
  check('changed tree REFUSES the plan', stale.state === 'refused' && stale.code === 'stale', JSON.stringify(stale).slice(0, 160) + ' — applyPlan in src/platform/git-graph/plan.ts must refuse with code stale when the tree changed since preparePlan')
  check('stale refusal committed NOTHING', sh(['rev-list', '--count', 'HEAD']).trim() === preCount, 'applyPlan in src/platform/git-graph/plan.ts must check the digest before it commits anything')
  check('plan record reads stale', getPlan(owner, plan2.id)?.state === 'stale', 'applyPlan in src/platform/git-graph/plan.ts must set the plan state to stale when it refuses')
  check('verify names the drift', verifyPlan(owner, root, plan2.id).includes('DRIFTED'), 'verifyPlan in src/platform/git-graph/plan.ts must say DRIFTED for a plan whose tree changed')

  const plan2b = preparePlan(owner, root, [{ files: ['core.ts'], message: 'feat: later take 2' }])
  if ('reason' in plan2b) throw new Error(plan2b.reason)
  appendFileSync(join(root, 'core.ts'), 'export const sameFileDrift = 4\n')
  const stale2 = applyPlan(owner, plan2b.id)
  check(
    'SAME-file content drift REFUSES the plan (content-hashed digest)',
    stale2.state === 'refused' && stale2.code === 'stale',
    JSON.stringify(stale2).slice(0, 160) + ' — the digest built by preparePlan in src/platform/git-graph/plan.ts must hash file content, not only file names',
  )

  console.log('── partial-hunk planning ──')
  const lines = readFileSync(join(root, 'hunky.txt'), 'utf8').split('\n')
  lines[2] = 'line-2 EDITED-TOP'
  lines[27] = 'line-27 EDITED-BOTTOM'
  writeFileSync(join(root, 'hunky.txt'), lines.join('\n'))
  const absorb = preparePlan(owner, root, [
    { files: ['core.ts', 'docs.md', 'leftover.txt'], message: 'chore: absorb' },
  ])
  if ('reason' in absorb) throw new Error(absorb.reason)
  const absorbed = applyPlan(owner, absorb.id)
  check('absorb plan applied', absorbed.state === 'applied')

  const hunkDiff = gitDiff(root, { scope: 'worktree', paths: ['hunky.txt'] })
  if ('state' in hunkDiff) throw new Error(hunkDiff.note)
  check('two hunks present', hunkDiff.hunks.length === 2, `${hunkDiff.hunks.length} — gitDiff or parseUnifiedDiff in src/platform/git-graph/observe.ts must return one hunk per separated edit`)
  const firstHunk = hunkDiff.hunks[0]!
  const hunkPlan = preparePlan(owner, root, [
    { files: ['hunky.txt'], hunks: { 'hunky.txt': [firstHunk.id] }, message: 'feat: top edit only' },
  ])
  if ('reason' in hunkPlan) throw new Error(hunkPlan.reason)
  const hunkApplied = applyPlan(owner, hunkPlan.id)
  check('hunk plan applied', hunkApplied.state === 'applied', JSON.stringify(hunkApplied).slice(0, 200) + ' — see applyPlan in src/platform/git-graph/plan.ts')
  const committedContent = sh(['show', 'HEAD:hunky.txt'])
  check(
    'committed content has ONLY the planned hunk',
    committedContent.includes('EDITED-TOP') && !committedContent.includes('EDITED-BOTTOM'),
    'applyPlan in src/platform/git-graph/plan.ts must commit only the hunks named in the plan hunks map',
  )
  const worktreeNow = readFileSync(join(root, 'hunky.txt'), 'utf8')
  check(
    'the other hunk SURVIVES in the worktree',
    worktreeNow.includes('EDITED-BOTTOM') && sh(['status', '--porcelain']).includes('hunky.txt'),
    'applyPlan in src/platform/git-graph/plan.ts must leave unplanned hunks in the working copy',
  )

  console.log('── stage / restore round-trip ──')
  const staged = stageSelection(root, ['hunky.txt'])
  check('stage exact file', staged.state === 'ok')
  const afterStage = gitStatus(root)
  check('index shows it staged', !('state' in afterStage) && afterStage.files.some(f => f.path === 'hunky.txt' && f.staged === 'M'), 'stageSelection in src/platform/git-graph/plan.ts must stage the file; gitStatus in src/platform/git-graph/observe.ts must report it staged')
  const restored = restoreStaged(root, ['hunky.txt'])
  check('restore is index-only', restored.state === 'ok', JSON.stringify(restored).slice(0, 160) + ' — see restoreStaged in src/platform/git-graph/plan.ts')
  const afterRestore = gitStatus(root)
  check(
    'working copy untouched by restore',
    readFileSync(join(root, 'hunky.txt'), 'utf8') === worktreeNow &&
      !('state' in afterRestore) &&
      afterRestore.files.some(f => f.path === 'hunky.txt' && f.unstaged === 'M' && f.staged === ''),
    'restoreStaged in src/platform/git-graph/plan.ts must unstage without touching the working copy',
  )

  console.log('── cancellation ──')
  const cancelPlan = preparePlan(owner, root, [{ files: ['hunky.txt'], message: 'never lands' }])
  if ('reason' in cancelPlan) throw new Error(cancelPlan.reason)
  const ac = new AbortController()
  ac.abort()
  const preCancelCount = sh(['rev-list', '--count', 'HEAD']).trim()
  const cancelled = applyPlan(owner, cancelPlan.id, { signal: ac.signal })
  check('cancelled before applying', cancelled.state === 'refused' && cancelled.code === 'cancelled', JSON.stringify(cancelled).slice(0, 160) + ' — applyPlan in src/platform/git-graph/plan.ts must refuse with code cancelled when the signal is already aborted')
  check('cancellation committed nothing', sh(['rev-list', '--count', 'HEAD']).trim() === preCancelCount, 'applyPlan in src/platform/git-graph/plan.ts must check the abort signal before it commits')

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
  }
  const resolved = resolveConflict(owner, root, 'docs.md', { take: 'ours' })
  check('resolve(ours) succeeds + stages', resolved.state === 'ok', JSON.stringify(resolved).slice(0, 160) + ' — see resolveConflict in src/platform/git-graph/plan.ts')
  const afterResolve = gitStatus(root)
  check(
    'conflict cleared from the index',
    !('state' in afterResolve) && !afterResolve.files.some(f => f.kind === 'unmerged'),
    'resolveConflict in src/platform/git-graph/plan.ts must stage the resolved file so it leaves the unmerged state',
  )
  check('ours content won', readFileSync(join(root, 'docs.md'), 'utf8').includes('MAIN'))
} finally {
  rmSync(root, { recursive: true, force: true })
  _resetGitPlanStoreForTesting()
}

console.log(failures === 0 ? 'GIT PLANS: ALL GREEN' : `GIT PLANS: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
