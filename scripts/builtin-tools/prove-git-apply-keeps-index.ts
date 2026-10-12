#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { preparePlan, applyPlan, _resetGitPlanStoreForTesting } = await import('../../src/services/gitGraph/plan.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
await import('../../src/services/resources/adapters/git.ts')

const owner = processMainOwner()
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'proof',
  GIT_AUTHOR_EMAIL: 'proof@local',
  GIT_COMMITTER_NAME: 'proof',
  GIT_COMMITTER_EMAIL: 'proof@local',
}
function repo(): { root: string; sh: (args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'git-apply-index-'))
  const sh = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env })
  return { root, sh }
}
const porcelain = (sh: (a: string[]) => string): string[] => sh(['status', '--porcelain']).split('\n').filter(Boolean).sort()

const worlds: string[] = []
try {
  section("A. a commit of two files leaves the user's own staged third file staged, as found")
  {
    const { root, sh } = repo()
    worlds.push(root)
    sh(['init', '--quiet', '--initial-branch=main'])
    for (const name of ['calc.py', 'NOTES.md', 'report.py', 'run.sh']) writeFileSync(join(root, name), `${name} line one\n`)
    sh(['add', '.'])
    sh(['commit', '--quiet', '-m', 'seed'])
    for (const name of ['calc.py', 'NOTES.md', 'report.py', 'run.sh']) appendFileSync(join(root, name), `${name} line two\n`)
    sh(['add', '--', 'report.py', 'run.sh'])
    appendFileSync(join(root, 'run.sh'), 'run.sh line three, unstaged\n')
    const before = porcelain(sh)
    check('the user staged report.py and run.sh (run.sh with a further unstaged line) before the plan', JSON.stringify(before) === JSON.stringify([' M NOTES.md', ' M calc.py', 'M  report.py', 'MM run.sh']), JSON.stringify(before))
    const stagedBlobBefore = sh(['rev-parse', ':run.sh']).trim()
    _resetGitPlanStoreForTesting()
    const plan = preparePlan(owner, root, [{ files: ['calc.py', 'NOTES.md'], message: 'two files via git tool' }])
    check('the plan prepares', !('state' in plan && plan.state === 'refused'), 'state' in plan ? String((plan as { reason?: string }).reason) : '')
    if (!('state' in plan && plan.state === 'refused')) {
      const outcome = applyPlan(owner, (plan as { id: string }).id, {})
      check('the plan applies', outcome.state === 'applied', outcome.state !== 'applied' ? String((outcome as { reason?: string }).reason) : '')
      const committed = sh(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort()
      check('the commit holds exactly the two planned files', JSON.stringify(committed) === JSON.stringify(['NOTES.md', 'calc.py']), JSON.stringify(committed))
      check('the commit message is the plan\'s', sh(['log', '-1', '--format=%s']).trim() === 'two files via git tool')
      const after = porcelain(sh)
      check("the user's staged files are still staged, exactly as found (RED on the base: the apply reset the index and left them unstaged)", JSON.stringify(after) === JSON.stringify(['M  report.py', 'MM run.sh']), JSON.stringify(after))
      check("run.sh's staged blob is the one the user staged (the unstaged third line stayed out of the index)", sh(['rev-parse', ':run.sh']).trim() === stagedBlobBefore)
      check('the committed files are clean in the index and the worktree', !after.some(row => row.endsWith('calc.py') || row.endsWith('NOTES.md')))
      check('working content untouched', readFileSync(join(root, 'run.sh'), 'utf8').endsWith('run.sh line three, unstaged\n') && readFileSync(join(root, 'report.py'), 'utf8') === 'report.py line one\nreport.py line two\n')
    }
  }

  section('B. a hunk-selected commit stages only the chosen hunk and leaves another staged file alone')
  {
    const { root, sh } = repo()
    worlds.push(root)
    sh(['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(root, 'hunky.txt'), Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') + '\n')
    writeFileSync(join(root, 'other.txt'), 'other one\n')
    sh(['add', '.'])
    sh(['commit', '--quiet', '-m', 'seed'])
    const lines = readFileSync(join(root, 'hunky.txt'), 'utf8').split('\n')
    lines[2] = 'line-2 CHANGED'
    lines[25] = 'line-25 CHANGED'
    writeFileSync(join(root, 'hunky.txt'), lines.join('\n'))
    appendFileSync(join(root, 'other.txt'), 'other two\n')
    sh(['add', '--', 'other.txt'])
    const { gitDiff } = await import('../../src/services/gitGraph/observe.ts')
    const diff = gitDiff(root, { paths: ['hunky.txt'] })
    const ids = 'hunks' in diff ? diff.hunks.filter(h => h.file === 'hunky.txt').map(h => h.id) : []
    check('two hunks to choose from', ids.length === 2, JSON.stringify(diff).slice(0, 200))
    _resetGitPlanStoreForTesting()
    const plan = preparePlan(owner, root, [{ files: ['hunky.txt'], hunks: { 'hunky.txt': [ids[0]!] }, message: 'first hunk only' }])
    const outcome = 'state' in plan && plan.state === 'refused' ? plan : applyPlan(owner, (plan as { id: string }).id, {})
    check('the hunk plan applies', outcome.state === 'applied', String((outcome as { reason?: string }).reason ?? ''))
    const committedText = sh(['show', 'HEAD:hunky.txt'])
    check('the commit holds the first hunk and not the second', committedText.includes('line-2 CHANGED') && !committedText.includes('line-25 CHANGED'))
    const after = porcelain(sh)
    check("the user's staged other.txt is still staged and the second hunk is still an unstaged change (RED on the base: other.txt unstaged)", JSON.stringify(after) === JSON.stringify([' M hunky.txt', 'M  other.txt']), JSON.stringify(after))
  }

  section('C. the first commit of a repository with no commit yet still lands')
  {
    const { root, sh } = repo()
    worlds.push(root)
    sh(['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(root, 'first.txt'), 'first\n')
    writeFileSync(join(root, 'second.txt'), 'second\n')
    _resetGitPlanStoreForTesting()
    const plan = preparePlan(owner, root, [{ files: ['first.txt'], message: 'the first commit' }])
    const outcome = 'state' in plan && plan.state === 'refused' ? plan : applyPlan(owner, (plan as { id: string }).id, {})
    check('the plan applies on an unborn branch', outcome.state === 'applied', String((outcome as { reason?: string }).reason ?? ''))
    if (outcome.state === 'applied') {
      check('HEAD holds exactly first.txt', sh(['show', '--name-only', '--format=', 'HEAD']).trim() === 'first.txt')
      check('second.txt stays untracked', JSON.stringify(porcelain(sh)) === JSON.stringify(['?? second.txt']), JSON.stringify(porcelain(sh)))
    }
  }
} finally {
  for (const root of worlds) rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
