#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedTurn } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-scout-reads-git')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'scout-reads-git-')))
console.log(`build under proof: ${DIST}`)

const STEM = 'mercury-scout is read-only:'
const OWN = 'git --no-pager -c core.quotepath=false -c core.fsmonitor=false -c core.pager=cat'
const OWN_MARK = 'core.fsmonitor=false'
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
writeFileSync(join(project, 'src', 'calc.ts'), 'export function total(items: number[]): number {\n  let sum = 0\n  for (let i = 0; i <= items.length; i++) sum += items[i] as number\n  return sum\n}\n')
git(project, 'commit', '-q', '-am', 'loop by index')
const HEAD = git(project, 'rev-parse', 'HEAD')

const READS: Array<[string, (out: string) => boolean]> = [
  ['git log --oneline -3', out => out.includes('loop by index') && out.includes('sum the items')],
  ['git status --porcelain', out => !out.includes('calc.ts')],
  ['git diff HEAD~1 HEAD', out => out.includes('-  for (const item of items) sum += item') && out.includes('+  for (let i = 0')],
  ['git show --stat HEAD', out => out.includes('loop by index') && out.includes('src/calc.ts')],
  ['git blame src/calc.ts', out => out.includes('for (let i = 0')],
  ['git log --oneline -3 | head -1', out => out.includes('loop by index') && !out.includes('sum the items')],
  ['bash -c "git log --oneline -1"', out => out.includes('loop by index')],
  ['git stash list', out => !out.includes('stash@')],
]
const WRITES = ['git add src/calc.ts', 'git commit --allow-empty -m changed', 'git checkout -b other', 'git reset --hard HEAD~1', 'git stash', 'git apply /dev/null', 'git push']
const SETTINGS = ['git -c core.pager=/bin/echo log', 'git --exec-path=/tmp log', `git -C ${outside} log --oneline -1`]
const ONE_BYTE_OFF = `${OWN.replace('core.pager=cat', 'core.pager=cap')} log --no-ext-diff --no-textconv --oneline -1`
const TO_A_FILE = 'git log --oneline -1 > out.txt'
const REFUSED = [...WRITES, ...SETTINGS, ONE_BYTE_OFF, TO_A_FILE]
const COMMANDS = [...READS.map(([command]) => command), ...REFUSED]

const answers: Array<{ text: string; isError: boolean } | undefined> = []
let handed = ''
let scoutRequests = 0
let scoutTools: string[] = []
const fixture = await startScriptedFixture(req => {
  if (/^Seat: scout$/m.test(req.allTexts.slice(0, 12).join('\n'))) {
    scoutRequests++
    if (scoutRequests === 1) scoutTools = req.toolNames
    if (scoutRequests >= 2 && scoutRequests - 2 < COMMANDS.length) answers[scoutRequests - 2] = req.results[0]
    if (scoutRequests <= COMMANDS.length) return [{ type: 'tool_use', name: 'Bash', input: { command: COMMANDS[scoutRequests - 1] as string, description: 'a scout command' } }]
    return [{ type: 'text', text: 'The history was read.' }]
  }
  if (req.step === 0) return [{ type: 'tool_use', name: 'Crewmate', input: { description: 'Read the history', name: 'scout', prompt: 'Seat: scout\nRead the history of this repository with git.', crewmate_type: 'mercury-scout' } }]
  if (req.step === 1) handed = req.results[0]?.text ?? ''
  return [{ type: 'text', text: 'done' }]
})
let turn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: project, base: fixture.base, ask: 'read the history', timeoutMs: 240_000, extraEnv: { HOME: home, USERPROFILE: home } })
} finally {
  await fixture.close()
}
const said = (command: string): { text: string; isError: boolean } => answers[COMMANDS.indexOf(command)] ?? { text: '(no answer reached the wire)', isError: true }
const shown = (command: string): string => command.replace(outside, '<outside>').replace(OWN.replace('core.pager=cat', 'core.pager=cap'), 'git <Mercury\'s settings, one byte off>')
const flat = (text: string): string => text.replace(/\s+/g, ' ').slice(0, 240)

tally.section('the read-only crewmate reads a repository\'s history with git')
tally.check('the scout ran to its end in the checkout, with a shell and no tool that writes', turn.exitCode === 0 && handed.startsWith('The history was read.') && scoutTools.includes('Bash') && !scoutTools.includes('Write') && !scoutTools.includes('Edit'), `exit ${turn.exitCode} · ${flat(handed)} · ${turn.stderr.slice(-300)}`)
for (const [command, holds] of READS.slice(0, 7)) {
  const answer = said(command)
  tally.check(`${command} runs and answers`, !answer.isError && holds(answer.text), flat(answer.text))
}
const stashList = said('git stash list')
tally.check('git stash list runs in a repository that carries its own filter program, whose settings the shell adds to the command', git(project, 'config', '--get', 'filter.guard.clean') === 'tools/guard.sh' && !stashList.isError && (READS[7] as [string, (out: string) => boolean])[1](stashList.text), flat(stashList.text))

tally.section('what a scout was refused is refused still, in the scout\'s own sentence')
for (const command of REFUSED) {
  const answer = said(command)
  tally.check(`${shown(command)} is refused`, answer.isError && answer.text.includes(STEM), flat(answer.text))
}

tally.section('a refusal names the command the model typed')
const spoken = WRITES.filter(command => said(command).text.includes(`\`${command}\` is not a read-only form of \`git\``))
tally.check('each git write is refused by its own words as typed', spoken.length === WRITES.length, WRITES.filter(command => !spoken.includes(command)).join(' · '))
const rewritten = COMMANDS.filter(command => !command.includes(OWN_MARK) && said(command).text.includes(OWN_MARK))
tally.check('no answer shows the shell\'s own settings to a model that did not type them', rewritten.length === 0, rewritten.map(command => `${command}: ${flat(said(command).text)}`).join(' · ').slice(0, 600))
tally.check('the redirect is refused for the file it writes', said(TO_A_FILE).text.includes('the command writes to `out.txt`'), flat(said(TO_A_FILE).text))

tally.section('nothing moved under the scout')
tally.check('the checkout stands at its commit with nothing staged, changed, stashed or written, and no branch made', git(project, 'rev-parse', 'HEAD') === HEAD && git(project, 'status', '--porcelain') === '' && git(project, 'stash', 'list') === '' && git(project, 'branch', '--list', 'other') === '' && !existsSync(join(project, 'out.txt')), `${git(project, 'status', '--porcelain')} | ${git(project, 'stash', 'list')} | ${git(project, 'branch', '--list', 'other')}`)
rmSync(scratch, { recursive: true, force: true })
tally.finish()
