#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-git-tool-folder')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'git-tool-folder-'))
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'proof',
  GIT_AUTHOR_EMAIL: 'proof@local',
  GIT_COMMITTER_NAME: 'proof',
  GIT_COMMITTER_EMAIL: 'proof@local',
}

function repository(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--quiet', '--initial-branch=main')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'src', 'b.txt'), 'two\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'seed')
  writeFileSync(join(dir, 'a.txt'), 'one\nmore\n')
}

const parent = join(scratch, 'parent')
const twice = join(scratch, 'twice')
const nowhere = join(scratch, 'nowhere')
repository(join(parent, 'app'))
repository(join(twice, 'app'))
repository(join(twice, 'lib'))
mkdirSync(nowhere, { recursive: true })

type Road = { name: string; cwd: string; input: Record<string, unknown> }
const roads: Road[] = [
  { name: 'inside', cwd: join(parent, 'app', 'src'), input: { op: 'status' } },
  { name: 'subfolder', cwd: parent, input: { op: 'status', cwd: 'app/src' } },
  { name: 'one-below', cwd: parent, input: { op: 'status' } },
  { name: 'two-below', cwd: twice, input: { op: 'status' } },
  { name: 'none', cwd: nowhere, input: { op: 'status' } },
]

const seen = new Map<string, SeenResult>()
const fixture = await startScriptedFixture(req => {
  const m = /^git-probe:(\S+)/.exec(req.ask.trim())
  const road = m ? roads.find(r => r.name === m[1]) : undefined
  if (!road) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Git', input: road.input }]
  const last = req.results[req.results.length - 1]
  if (last && !seen.has(road.name)) seen.set(road.name, last)
  return [{ type: 'text', text: `done: ${road.name}` }]
})

const turns: Record<string, { exitCode: number | null; stderrTail: string }> = {}
try {
  for (const road of roads) {
    const turn = await runScriptedTurn({ runHome: join(scratch, `home-${road.name}`), cwd: road.cwd, base: fixture.base, ask: `git-probe:${road.name}` })
    turns[road.name] = { exitCode: turn.exitCode, stderrTail: turn.stderr.slice(-400) }
  }
} finally {
  await fixture.close()
}

const wordsOf = (name: string): string => seen.get(name)?.text ?? `(no tool result reached the wire; run exit ${turns[name]?.exitCode ?? '?'}: ${turns[name]?.stderrTail ?? ''})`
const isError = (name: string): boolean => seen.get(name)?.isError === true
const branchLine = /\bmain @ [0-9a-f]{8}\b/
for (const road of roads) console.log(`\n── ${road.name} (session folder ${road.cwd}) ──\n${wordsOf(road.name).split('\n').map(l => `│ ${l}`).join('\n')}`)

tally.section('inside the repository: the session folder is a subfolder and git walks up — unchanged')
tally.check('status answers the branch from inside a subfolder', branchLine.test(wordsOf('inside')) && !isError('inside'), wordsOf('inside'))

tally.section('a subfolder path: the session folder is the parent, cwd names a subfolder of the repository')
tally.check('status runs in the named subfolder and answers the branch', branchLine.test(wordsOf('subfolder')) && !isError('subfolder'), wordsOf('subfolder'))

tally.section('the session folder is not a repository and holds exactly one repository directly below it')
tally.check('status answers from that one repository', branchLine.test(wordsOf('one-below')) && !isError('one-below'), wordsOf('one-below'))
tally.check('…and names the repository it used and the folder it looked in', wordsOf('one-below').includes(join(parent, 'app')) && wordsOf('one-below').includes(parent), wordsOf('one-below'))

tally.section('the session folder is not a repository and holds two repositories directly below it')
tally.check('refused, naming the folder it looked in and both repositories', !branchLine.test(wordsOf('two-below')) && wordsOf('two-below').includes(twice) && /\bapp\b/.test(wordsOf('two-below')) && /\blib\b/.test(wordsOf('two-below')), wordsOf('two-below'))

tally.section('no repository at the session folder, above it, or directly below it')
tally.check('refused, naming the folder it looked in', !branchLine.test(wordsOf('none')) && wordsOf('none').includes(nowhere), wordsOf('none'))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
