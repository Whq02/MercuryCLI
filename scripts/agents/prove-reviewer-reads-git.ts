#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedTurn, type WireBlock } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-reviewer-reads-git')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'reviewer-reads-git-')))
console.log(`build under proof: ${DIST}`)

const REFUSAL = 'Reviewer tools allow read-only commands and confined bun/bash verification under scripts, not shell writes, Git mutations or arbitrary programs.'
const OWN = 'git --no-pager -c core.quotepath=false -c core.fsmonitor=false -c core.pager=cat'
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const home = join(scratch, 'user-home')
const project = join(scratch, 'project')
const outside = join(scratch, 'outside')
mkdirSync(home)
for (const repo of [project, outside]) {
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'tools'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '.mercury/\n')
  writeFileSync(join(repo, 'tools', 'guard.sh'), '#!/bin/sh\ncat\n')
  chmodSync(join(repo, 'tools', 'guard.sh'), 0o755)
  writeFileSync(join(repo, 'src', 'calc.ts'), 'export function total(items: number[]): number {\n  let sum = 0\n  for (const item of items) sum += item\n  return sum\n}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'sum the items')
}
git(project, 'config', 'filter.guard.clean', 'tools/guard.sh')
const BASE = git(project, 'rev-parse', 'HEAD')
writeFileSync(join(project, 'src', 'calc.ts'), 'export function total(items: number[]): number {\n  let sum = 0\n  for (let i = 0; i <= items.length; i++) sum += items[i] as number\n  return sum\n}\n')
git(project, 'commit', '-q', '-am', 'loop by index')
const HEAD = git(project, 'rev-parse', 'HEAD')

const READS: Array<[string, (out: string) => boolean]> = [
  ['git show --stat HEAD', out => out.includes('loop by index') && out.includes('src/calc.ts')],
  [`git show ${HEAD}`, out => out.includes('+  for (let i = 0; i <= items.length; i++)')],
  [`git diff ${BASE} ${HEAD}`, out => out.includes('-  for (const item of items) sum += item') && out.includes('+  for (let i = 0')],
  ['git log --oneline -3', out => out.includes('loop by index') && out.includes('sum the items')],
  ['git status --porcelain', out => !out.includes('calc.ts')],
  ['git rev-parse HEAD', out => out.includes(HEAD)],
  ['git ls-files', out => out.includes('src/calc.ts')],
  ['git blame src/calc.ts', out => out.includes('for (let i = 0')],
  ['git log --oneline -3 | head -1', out => out.includes('loop by index') && !out.includes('sum the items')],
  ['git diff --no-ext-diff --no-textconv HEAD~1 HEAD', out => out.includes('+  for (let i = 0')],
  ['git stash list', out => !out.includes('stash@')],
  ['bash -c "git log --oneline -1"', out => out.includes('loop by index')],
]
const REFUSED = [
  'git -c core.pager=/bin/echo log',
  'git -c core.fsmonitor=/bin/echo status',
  'git -c alias.x=!/bin/echo x',
  'git --exec-path=/tmp log',
  `git -C ${outside} log --oneline -1`,
  `${OWN.replace('core.pager=cat', 'core.pager=cap')} log --no-ext-diff --no-textconv --oneline -1`,
  `${OWN.replace('core.fsmonitor=false', 'core.fsmonitor=true')} status --porcelain`,
  `${OWN} log --no-ext-diff --no-textconv --oneline -1`,
  'git add src/calc.ts',
  'git commit --allow-empty -m changed',
  'git checkout -b other',
  'git reset --hard HEAD~1',
  'git stash',
  'git apply /dev/null',
  'git push',
  `${OWN} add src/calc.ts`,
  'git log --oneline -1 > out.txt',
  `${OWN} log --no-ext-diff --no-textconv --oneline -1 > out.txt`,
]
const COMMANDS = [...READS.map(([command]) => command), ...REFUSED]

const answers: Array<{ text: string; isError: boolean } | undefined> = []
let receipt = ''
let handed = ''
let receiptText = ''
let reviewerRequests = 0
const fixture = await startScriptedFixture(req => {
  const texts = req.allTexts.slice(0, 12).join('\n')
  if (/^Seat: reviewer$/m.test(texts)) {
    reviewerRequests++
    if (reviewerRequests >= 2 && reviewerRequests - 2 < COMMANDS.length) answers[reviewerRequests - 2] = req.results[0]
    if (reviewerRequests <= COMMANDS.length) return [{ type: 'tool_use', name: 'Bash', input: { command: COMMANDS[reviewerRequests - 1] as string, description: 'a reviewer command' } }]
    if (reviewerRequests === COMMANDS.length + 1) return [{ type: 'tool_use', name: 'Edit', input: { file_path: receipt, section: '## Review', append: '- Checked: the diff was read with git.' } }]
    return [{ type: 'text', text: 'The diff was read.\nREVIEW: CLEAN' }]
  }
  if (req.step === 0) receipt = `${/Scratchpad directory: (\S+)/.exec(req.system)?.[1] ?? ''}/reviewer.md`
  const steps: WireBlock[][] = [
    [{ type: 'tool_use', name: 'Write', input: { file_path: receipt, content: 'Review context: the last commit.\n\n## Review\n' } }],
    [{ type: 'tool_use', name: 'Crewmate', input: { description: 'Review the commit', name: 'reviewer', prompt: 'Seat: reviewer\nRead the diff of the reviewed commit with git.', crewmate_type: 'mercury-crew', isolation: 'worktree', worktree_at: HEAD, review_receipt: receipt } }],
    [{ type: 'tool_use', name: 'Read', input: { file_path: receipt } }],
  ]
  if (req.step === 2) handed = req.results[0]?.text ?? ''
  if (req.step === 3) receiptText = req.results[0]?.text ?? ''
  return steps[req.step] ?? [{ type: 'text', text: 'reviewed' }]
})
let turn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: project, base: fixture.base, ask: 'review the last commit', timeoutMs: 240_000, extraEnv: { HOME: home, USERPROFILE: home } })
} finally {
  await fixture.close()
}
const said = (command: string): { text: string; isError: boolean } => answers[COMMANDS.indexOf(command)] ?? { text: '(no answer reached the wire)', isError: true }
const lanesHome = join(project, '.mercury', 'worktrees')
const lanes = existsSync(lanesHome) ? readdirSync(lanesHome).filter(name => name.startsWith('agent-')) : []
const lane = lanes.length === 1 ? join(lanesHome, lanes[0] as string) : ''

tally.section('a reviewer on a frozen worktree reads the commit it reviews with git')
tally.check('the review ran to its end: one frozen lane at the reviewed commit, the report ending REVIEW: CLEAN', turn.exitCode === 0 && lane !== '' && git(lane, 'rev-parse', 'HEAD') === HEAD && handed.startsWith('The diff was read.\nREVIEW: CLEAN'), `exit ${turn.exitCode} · ${lanes.length} lane(s) · ${handed.slice(0, 200)} · ${turn.stderr.slice(-300)}`)
for (const [command, holds] of READS) {
  const answer = said(command)
  tally.check(`${command.replace(HEAD, '<head>').replace(BASE, '<base>')} runs and answers`, !answer.isError && holds(answer.text), answer.text.replace(/\s+/g, ' ').slice(0, 220))
}

tally.section('what a reviewer was refused is refused still, in the reviewer\'s own sentence')
for (const command of REFUSED) {
  const answer = said(command)
  tally.check(`${command.replace(outside, '<outside>').replace(OWN, 'git <Mercury\'s own settings>')} is refused`, answer.isError && answer.text.includes(REFUSAL), answer.text.replace(/\s+/g, ' ').slice(0, 220))
}

tally.section('nothing moved under the review')
tally.check('the frozen lane stands at the reviewed commit with nothing staged, changed, stashed or written', lane !== '' && git(lane, 'rev-parse', 'HEAD') === HEAD && git(lane, 'status', '--porcelain') === '' && git(lane, 'stash', 'list') === '' && !existsSync(join(lane, 'out.txt')), lane === '' ? 'no lane' : `${git(lane, 'status', '--porcelain')} | ${git(lane, 'stash', 'list')}`)
tally.check('the repository holds no branch the review made and no commit beyond the reviewed one', git(project, 'branch', '--list', 'other') === '' && git(project, 'rev-parse', 'HEAD') === HEAD && git(project, 'status', '--porcelain') === '')
tally.check('the reviewer\'s one write is its line under Review in the receipt', receiptText.includes('## Review') && receiptText.includes('- Checked: the diff was read with git.'), receiptText.replace(/\s+/g, ' ').slice(0, 220))
rmSync(scratch, { recursive: true, force: true })
tally.finish()
