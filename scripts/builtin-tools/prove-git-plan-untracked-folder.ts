#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { gitStatus } = await import('../../src/services/gitGraph/observe.ts')
const { preparePlan, applyPlan, _resetGitPlanStoreForTesting } = await import('../../src/services/gitGraph/plan.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const owner = processMainOwner()
const root = mkdtempSync(join(tmpdir(), 'builtin-tools-untracked-folder-'))
function sh(args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@local', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@local' },
  })
}

try {
  sh(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'README.md'), '# quiz\n')
  writeFileSync(join(root, 'package.json'), '{"name":"quiz"}\n')
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'test', 'score.test.js'), 'test 1\n')
  writeFileSync(join(root, 'test', 'quiz.test.js'), 'test 2\n')

  console.log('── status lists the files under an untracked folder, never the folder ──')
  const status = gitStatus(root)
  if ('state' in status) throw new Error(status.note)
  const paths = status.files.map(f => f.path).sort()
  check('four untracked files, each by name', JSON.stringify(paths) === JSON.stringify(['README.md', 'package.json', 'test/quiz.test.js', 'test/score.test.js']), JSON.stringify(paths))
  check('no folder entry', !paths.some(p => p.endsWith('/')), JSON.stringify(paths))

  console.log('── the folder spelling is refused at plan time, before any commit, naming the files status lists ──')
  const folderPlan = preparePlan(owner, root, [
    { files: ['README.md', 'package.json'], message: 'scaffold the quiz' },
    { files: ['test/'], message: 'add the tests' },
  ])
  check("'test/' is refused at plan time (never accepted by plan and refused by apply after commit 1)", 'reason' in folderPlan, JSON.stringify(folderPlan).slice(0, 200))
  if ('reason' in folderPlan) {
    check('the refusal names the files status lists under the folder', folderPlan.reason.includes('test/quiz.test.js') && folderPlan.reason.includes('test/score.test.js') && folderPlan.reason.includes('folder'), folderPlan.reason)
  } else {
    const half = applyPlan(owner, folderPlan.id)
    check('apply must not leave a half-finished chain', half.state === 'applied', JSON.stringify(half).slice(0, 300))
  }
  check('no commit exists after the refusal', (() => { try { return sh(['rev-list', '--count', 'HEAD']).trim() === '0' } catch { return true } })(), 'a commit landed')

  console.log('── a plan names the files under the folder: both commits land on a fresh repository ──')
  _resetGitPlanStoreForTesting()
  const plan = preparePlan(owner, root, [
    { files: ['README.md', 'package.json'], message: 'scaffold the quiz' },
    { files: ['test/score.test.js', 'test/quiz.test.js'], message: 'add the tests' },
  ])
  check('the plan is accepted', !('reason' in plan), 'reason' in plan ? plan.reason : '')
  if (!('reason' in plan)) {
    const applied = applyPlan(owner, plan.id)
    check('apply lands both groups', applied.state === 'applied' && applied.commits.length === 2, JSON.stringify(applied).slice(0, 300))
    if (applied.state === 'applied') {
      check('commit 1 holds exactly the scaffold', JSON.stringify(applied.commits[0]!.files) === JSON.stringify(['README.md', 'package.json']), JSON.stringify(applied.commits[0]!.files))
      check('commit 2 holds exactly the two test files', JSON.stringify(applied.commits[1]!.files) === JSON.stringify(['test/quiz.test.js', 'test/score.test.js']), JSON.stringify(applied.commits[1]!.files))
    }
    check('the tree is clean afterwards', sh(['status', '--porcelain']).trim() === '', sh(['status', '--porcelain']))
    check('two commits in history', sh(['rev-list', '--count', 'HEAD']).trim() === '2')
  }

  console.log('── a bare folder name is refused the same way ──')
  _resetGitPlanStoreForTesting()
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'a.md'), 'a\n')
  writeFileSync(join(root, 'docs', 'b.md'), 'b\n')
  const commitsBefore = (() => { try { return sh(['rev-list', '--count', 'HEAD']).trim() } catch { return '0' } })()
  for (const spelling of ['docs', 'docs/']) {
    const refused = preparePlan(owner, root, [{ files: [spelling], message: 'docs' }])
    check(`'${spelling}' is refused before any commit`, 'reason' in refused, JSON.stringify(refused).slice(0, 200))
    if ('reason' in refused) {
      check(`'${spelling}': the refusal names the files status lists under it`, refused.reason.includes('docs/a.md') && refused.reason.includes('docs/b.md') && refused.reason.includes('folder'), refused.reason)
    }
  }
  check('nothing was committed by the refusals', (() => { try { return sh(['rev-list', '--count', 'HEAD']).trim() === commitsBefore } catch { return commitsBefore === '0' } })())
  const unchanged = preparePlan(owner, root, [{ files: ['nope.md'], message: 'x' }])
  check('a file with no changes keeps the plain refusal', 'reason' in unchanged && unchanged.reason === "'nope.md' has no changes — a plan names only really-changed files", 'reason' in unchanged ? unchanged.reason : '')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
