#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { gitStatus, gitDiff } = await import('../../src/services/gitGraph/observe.ts')
const { preparePlan, applyPlan, _resetGitPlanStoreForTesting } = await import('../../src/services/gitGraph/plan.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
await import('../../src/services/resources/adapters/git.ts')

const owner = processMainOwner()
const env = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@local', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@local' }
const root = mkdtempSync(join(tmpdir(), 'git-names-'))
const sh = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env })

const ACCENT = 'café-notes.md'
const SPACE = 'my notes.txt'
const CJK = '日本語.md'
const EMOJI = 'notes 🎉.md'

try {
  sh(['init', '--quiet', '--initial-branch=main'])
  sh(['config', 'core.quotepath', 'true'])
  writeFileSync(join(root, ACCENT), 'café one\n')
  writeFileSync(join(root, SPACE), 'notes one\n')
  writeFileSync(join(root, 'plain.txt'), 'plain one\n')
  sh(['add', '.'])
  sh(['commit', '--quiet', '-m', 'seed'])
  appendFileSync(join(root, ACCENT), 'café two\n')
  appendFileSync(join(root, SPACE), 'notes two\n')
  writeFileSync(join(root, CJK), '日本語 one\n')
  writeFileSync(join(root, EMOJI), 'party one\n')

  console.log('── status spells the names as the operator does ──')
  const status = gitStatus(root)
  const paths = 'files' in status ? status.files.map(f => f.path).sort() : []
  check('status lists the accented, spaced, CJK and emoji names as they are (RED on the base: git\'s octal-escaped, quoted spelling)', JSON.stringify(paths) === JSON.stringify([SPACE, ACCENT, EMOJI, CJK].sort()), JSON.stringify(paths))
  check('no path carries a quote or a backslash escape', paths.every(p => !p.includes('"') && !p.includes('\\')), JSON.stringify(paths))

  console.log('── diff names the file as it is ──')
  const diff = gitDiff(root, { paths: [ACCENT] })
  check('the diff of the accented file is found under its real name', 'files' in diff && diff.files.some(f => f.path === ACCENT), JSON.stringify(diff).slice(0, 200))

  console.log('── a plan with the real names prepares and applies ──')
  _resetGitPlanStoreForTesting()
  const plan = preparePlan(owner, root, [{ files: [ACCENT, SPACE, CJK, EMOJI], message: 'names test' }])
  check('the plan prepares with the real names (RED on the base: "has no changes")', !('state' in plan && plan.state === 'refused'), 'state' in plan ? String((plan as { reason?: string }).reason) : '')
  if (!('state' in plan && plan.state === 'refused')) {
    const outcome = applyPlan(owner, (plan as { id: string }).id, {})
    check('the plan applies', outcome.state === 'applied', String((outcome as { reason?: string }).reason ?? ''))
    const committed = sh(['-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort()
    check('the commit holds the four files under their real names', JSON.stringify(committed) === JSON.stringify([SPACE, ACCENT, EMOJI, CJK].sort()), JSON.stringify(committed))
    check('plain.txt stays out of it and the tree is clean', sh(['status', '--porcelain']).trim() === '')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
