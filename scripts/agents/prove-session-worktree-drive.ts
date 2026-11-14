#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { cloneRoadExpected } from '../lib/cloneRoad.ts'
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
const cloneRoad = cloneRoadExpected(scratch)
const probeChecks = (road: string, repo: string, lane: string, text: string, statusBefore: string, linked: boolean): void => {
  tally.check(`${road}: the shell ran in the worktree`, text.startsWith(`${lane}\n`), text.split('\n')[0])
  if (linked) {
    tally.check(`${road}: node_modules there is a link to the checkout's`, new RegExp(`node_modules -> ${rx(repo)}/node_modules`).test(text), text.split('\n').slice(1, 3).join(' | '))
    tally.check(`${road}: the vendored pack is a link too`, new RegExp(`vendor/pack-a -> ${rx(repo)}/vendor/pack-a`).test(text), text.split('\n').slice(1, 3).join(' | '))
  } else {
    tally.check(`${road}: node_modules there is the worktree's own directory, cloned from the checkout's`, /^d\S+ .* node_modules$/m.test(text) && !/node_modules -> /.test(text), text.split('\n').slice(1, 3).join(' | '))
    tally.check(`${road}: the vendored pack is the worktree's own directory too`, /^d\S+ .* vendor\/pack-a$/m.test(text) && !/vendor\/pack-a -> /.test(text), text.split('\n').slice(1, 3).join(' | '))
  }
  tally.check(`${road}: bun run typecheck exits 0 there`, /typecheck-ok rc=0/.test(text), text.slice(0, 400))
  tally.check(`${road}: git status in the worktree shows nothing`, /rc=0\nstatus-end/.test(text), text.slice(0, 400))
  if (linked) tally.check(`${road}: the checkout's exclude file hides the links`, excludeLinesOf(repo).includes('/node_modules') && excludeLinesOf(repo).includes('/vendor/pack-a'), excludeLinesOf(repo).join('|'))
  else tally.check(`${road}: the checkout's exclude file gains no line for a folder the worktree holds as its own`, !excludeLinesOf(repo).includes('/node_modules') && !excludeLinesOf(repo).includes('/vendor/pack-a'), excludeLinesOf(repo).join('|'))
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
  enterTurn = await runScriptedTurn({ runHome: join(scratch, 'home-enter'), cwd: repoEnter, base: enterFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--sovereign'] })
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
probeChecks('EnterWorktree', repoEnter, laneEnter, seen.enterProbe?.text ?? '', statusEnter, !cloneRoad)

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
  bootTurn = await runScriptedTurn({ runHome: join(scratch, 'home-boot'), cwd: repoBoot, base: bootFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--sovereign', '--worktree', 'boot-lane'] })
} finally {
  await bootFixture.close()
}
show('the probe in the worktree opened at boot', seen.bootProbe, bootTurn)
tally.section('the --worktree boot road: the worktree comes ready to build')
const laneBoot = join(repoBoot, '.mercury', 'worktrees', 'boot-lane')
tally.check('the boot opened the worktree under the repository worktrees home', existsSync(join(laneBoot, 'package.json')), laneBoot)
probeChecks('--worktree', repoBoot, laneBoot, seen.bootProbe?.text ?? '', statusBoot, !cloneRoad)

const repoLinked = seedRepo('repo-linked')
const statusLinked = authoredStatus(repoLinked)
const linkedFixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: PROBE, description: 'probe the worktree' } }]
  if (req.step === 1) seen.linkedProbe = req.results[req.results.length - 1]
  return [{ type: 'text', text: 'done' }]
})
let linkedTurn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  linkedTurn = await runScriptedTurn({ runHome: join(scratch, 'home-linked'), cwd: repoLinked, base: linkedFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--sovereign', '--worktree', 'linked-lane'], extraEnv: { MERCURY_WORKTREE_CLONE: 'off' } })
} finally {
  await linkedFixture.close()
}
show('the probe in the worktree opened at boot with MERCURY_WORKTREE_CLONE=off', seen.linkedProbe, linkedTurn)
tally.section('the --worktree boot road with MERCURY_WORKTREE_CLONE=off: the links of a volume that cannot clone')
const laneLinked = join(repoLinked, '.mercury', 'worktrees', 'linked-lane')
tally.check('the boot opened the worktree under the repository worktrees home', existsSync(join(laneLinked, 'package.json')), laneLinked)
probeChecks('--worktree, no clone', repoLinked, laneLinked, seen.linkedProbe?.text ?? '', statusLinked, true)

const runtimeForcesClone = ((): boolean => {
  writeFileSync(join(scratch, 'runtime-probe-a'), 'probe\n')
  try {
    execFileSync(NODE, ['-e', "const fs = require('node:fs'); fs.copyFileSync(process.argv[1], process.argv[2], fs.constants.COPYFILE_FICLONE_FORCE)", join(scratch, 'runtime-probe-a'), join(scratch, 'runtime-probe-b')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
console.log(`\nthe bundle's own runtime ${runtimeForcesClone ? 'forces' : 'refuses to force'} a clone of one file here (${process.platform})`)
const repoByFile = seedRepo('repo-by-file')
const statusByFile = authoredStatus(repoByFile)
const byFileFixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: PROBE, description: 'probe the worktree' } }]
  if (req.step === 1) seen.byFileProbe = req.results[req.results.length - 1]
  return [{ type: 'text', text: 'done' }]
})
let byFileTurn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  byFileTurn = await runScriptedTurn({ runHome: join(scratch, 'home-by-file'), cwd: repoByFile, base: byFileFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--sovereign', '--worktree', 'by-file-lane'], extraEnv: { MERCURY_WORKTREE_CLONE: 'files' } })
} finally {
  await byFileFixture.close()
}
show('the probe in the worktree opened at boot with MERCURY_WORKTREE_CLONE=files', seen.byFileProbe, byFileTurn)
tally.section(`the --worktree boot road, file by file (MERCURY_WORKTREE_CLONE=files): ${runtimeForcesClone ? "the worktree's own directories" : 'the first file is refused, so the links stand as on a volume that cannot clone'}`)
const laneByFile = join(repoByFile, '.mercury', 'worktrees', 'by-file-lane')
tally.check('the boot opened the worktree under the repository worktrees home', existsSync(join(laneByFile, 'package.json')), laneByFile)
probeChecks('--worktree, file by file', repoByFile, laneByFile, seen.byFileProbe?.text ?? '', statusByFile, !runtimeForcesClone)

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
