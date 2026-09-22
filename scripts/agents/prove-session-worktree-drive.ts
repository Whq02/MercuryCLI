#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedTurn, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-session-worktree-drive')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'session-worktree-drive-')))
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'worktree-probe'
const BUN = process.execPath
const PROBE = `pwd; ls -ld node_modules vendor/pack-a; "${BUN}" run typecheck; echo " rc=$?"; git status --porcelain; echo status-end`

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const authoredStatus = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall').split('\n').filter(line => line !== '' && !line.slice(3).startsWith('.mercury/')).join('\n')
const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const show = (label: string, r: SeenResult | undefined, turn: ScriptedTurn): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  for (const line of r.text.split('\n').slice(0, 12)) console.log(`│ ${line}`)
}
const seedRepo = (name: string): string => {
  const repo = join(scratch, name)
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  for (const [file, body] of Object.entries({
    '.gitignore': 'node_modules/\nvendor/*/\n',
    'package.json': JSON.stringify({ name: `${name}-fixture`, scripts: { typecheck: 'typecheck-fixture' } }),
    'vendor/pack-a.lock.json': '{}\n',
  })) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), body)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', '.bin', 'typecheck-fixture'), '#!/bin/sh\nprintf typecheck-ok\n')
  chmodSync(join(repo, 'node_modules', '.bin', 'typecheck-fixture'), 0o755)
  mkdirSync(join(repo, 'vendor', 'pack-a'))
  writeFileSync(join(repo, 'vendor', 'pack-a', 'marker'), 'pack\n')
  return repo
}
const excludeLinesOf = (repo: string): string[] => {
  const excludePath = join(repo, '.git', 'info', 'exclude')
  return existsSync(excludePath) ? readFileSync(excludePath, 'utf8').split('\n') : []
}
const probeChecks = (road: string, repo: string, lane: string, text: string, statusBefore: string): void => {
  tally.check(`${road}: the shell ran in the worktree`, text.startsWith(`${lane}\n`), text.split('\n')[0])
  tally.check(`${road}: node_modules there is a link to the checkout's`, new RegExp(`node_modules -> ${rx(repo)}/node_modules`).test(text), text.split('\n').slice(1, 3).join(' | '))
  tally.check(`${road}: the vendored pack is a link too`, new RegExp(`vendor/pack-a -> ${rx(repo)}/vendor/pack-a`).test(text), text.split('\n').slice(1, 3).join(' | '))
  tally.check(`${road}: bun run typecheck exits 0 there`, /typecheck-ok rc=0/.test(text), text.slice(0, 400))
  tally.check(`${road}: git status in the worktree shows nothing`, /rc=0\nstatus-end/.test(text), text.slice(0, 400))
  tally.check(`${road}: the checkout's exclude file hides the links`, excludeLinesOf(repo).includes('/node_modules') && excludeLinesOf(repo).includes('/vendor/pack-a'), excludeLinesOf(repo).join('|'))
  tally.check(`${road}: the checkout's own status is unchanged`, authoredStatus(repo) === statusBefore, authoredStatus(repo))
}

const seen: Record<string, SeenResult | undefined> = {}

const repoEnter = seedRepo('repo-enter')
const statusEnter = authoredStatus(repoEnter)
const enterFixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'EnterWorktree', input: { name: 'proof-lane' } }]
    case 1:
      seen.enter = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd', description: 'where the shell is after the hop' } }]
    case 2:
      seen.enterFirst = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: PROBE, description: 'probe the worktree' } }]
    default:
      if (req.step === 3) seen.enterProbe = last
      return [{ type: 'text', text: 'done' }]
  }
})
let enterTurn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  enterTurn = await runScriptedTurn({ runHome: join(scratch, 'home-enter'), cwd: repoEnter, base: enterFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await enterFixture.close()
}
show('the EnterWorktree call', seen.enter, enterTurn)
show('the first shell command after the hop', seen.enterFirst, enterTurn)
show('the probe in the entered worktree', seen.enterProbe, enterTurn)
console.log(`\nthe first shell command after the hop ran in: ${JSON.stringify((seen.enterFirst?.text ?? '').split('\n')[0])}`)
tally.section('the EnterWorktree road: the worktree comes ready to build')
const laneEnter = join(repoEnter, '.mercury', 'worktrees', 'proof-lane')
tally.check('EnterWorktree created the worktree under the repository worktrees home', seen.enter !== undefined && !seen.enter.isError && seen.enter.text.includes(`Created worktree ${laneEnter}`), seen.enter?.text.slice(0, 300))
probeChecks('EnterWorktree', repoEnter, laneEnter, seen.enterProbe?.text ?? '', statusEnter)

const repoBoot = seedRepo('repo-boot')
const statusBoot = authoredStatus(repoBoot)
const bootFixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: PROBE, description: 'probe the worktree' } }]
  if (req.step === 1) seen.bootProbe = req.results[req.results.length - 1]
  return [{ type: 'text', text: 'done' }]
})
let bootTurn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  bootTurn = await runScriptedTurn({ runHome: join(scratch, 'home-boot'), cwd: repoBoot, base: bootFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--dangerously-bypass-permissions', '--worktree', 'boot-lane'] })
} finally {
  await bootFixture.close()
}
show('the probe in the worktree opened at boot', seen.bootProbe, bootTurn)
tally.section('the --worktree boot road: the worktree comes ready to build')
const laneBoot = join(repoBoot, '.mercury', 'worktrees', 'boot-lane')
tally.check('the boot opened the worktree under the repository worktrees home', existsSync(join(laneBoot, 'package.json')), laneBoot)
probeChecks('--worktree', repoBoot, laneBoot, seen.bootProbe?.text ?? '', statusBoot)

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
