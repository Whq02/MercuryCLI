#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedTurn, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-agent-cwd-drive')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'agent-cwd-drive-')))
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'place-probe'
const WHERE_PROMPT = 'say where you are'
const BUILD_PROMPT = 'typecheck the checkout'
const BUN = process.execPath

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const authoredStatus = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall').split('\n').filter(line => line !== '' && !line.slice(3).startsWith('.mercury/')).join('\n')
const show = (label: string, r: SeenResult | undefined, turn: ScriptedTurn): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  for (const line of r.text.split('\n')) console.log(`│ ${line}`)
}

const work = join(scratch, 'work')
const lane = join(work, 'lane')
const missing = join(work, 'nowhere')
const elsewhere = join(scratch, 'elsewhere')
mkdirSync(lane, { recursive: true })
mkdirSync(elsewhere)

const pwds: string[] = []
const systems: string[] = []
const seen: Record<string, SeenResult | undefined> = {}
const whereFixture = await startScriptedFixture(req => {
  if (req.opening.trim() === WHERE_PROMPT) {
    if (req.step === 0) {
      systems.push(req.system)
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd', description: 'where am I' } }]
    }
    if (req.step === 1) pwds.push((req.results[0]?.text ?? '').split('\n')[0]?.trim() ?? '')
    return [{ type: 'text', text: 'agent done' }]
  }
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Agent', input: { description: 'where', prompt: WHERE_PROMPT, cwd: lane } }]
    case 1:
      seen.launch = last
      return [{ type: 'tool_use', name: 'Agent', input: { description: 'nowhere', prompt: WHERE_PROMPT, cwd: missing } }]
    case 2:
      seen.missing = last
      return [{ type: 'tool_use', name: 'Agent', input: { description: 'outside', prompt: WHERE_PROMPT, cwd: elsewhere } }]
    default:
      if (req.step === 3) seen.outside = last
      return [{ type: 'text', text: 'done' }]
  }
})
let whereTurn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  whereTurn = await runScriptedTurn({ runHome: join(scratch, 'home-where'), cwd: work, base: whereFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await whereFixture.close()
}
show('the launch into the named directory', seen.launch, whereTurn)
show('the launch into a missing directory', seen.missing, whereTurn)
show('the launch into a directory outside the trusted workspace', seen.outside, whereTurn)
console.log(`\npwd seen by the helpers: ${JSON.stringify(pwds)}`)

tally.section('a helper launched with cwd works there')
tally.check('the launch into the named directory answered without error', seen.launch !== undefined && !seen.launch.isError, seen.launch?.text.slice(0, 300))
tally.check("the helper's shell ran in the named directory", pwds[0] === lane, `pwd=${pwds[0] ?? '(none)'} wanted ${lane}`)
const envLine = systems[0]?.split('\n').find(line => line.startsWith('Working directory:')) ?? '(no env line)'
tally.check("the helper's environment section names the named directory", envLine === `Working directory: ${lane}`, envLine)
tally.check('a missing directory is refused typed before any spawn', seen.missing !== undefined && seen.missing.isError && /cwd does not exist/.test(seen.missing.text), seen.missing?.text.slice(0, 300))
tally.check('a directory outside every trusted workspace is refused with the write-scope sentence', seen.outside !== undefined && seen.outside.isError && /outside every workspace this session trusts/.test(seen.outside.text) && /write scope/.test(seen.outside.text), seen.outside?.text.slice(0, 300))
tally.check('the refused launches ran no helper', pwds.length === 1, JSON.stringify(pwds))

const repo = join(scratch, 'repo')
mkdirSync(repo)
git(repo, 'init', '-q', '-b', 'main')
for (const [name, body] of Object.entries({
  '.gitignore': 'node_modules/\nvendor/*/\n',
  'package.json': JSON.stringify({ name: 'drive-fixture', scripts: { typecheck: 'typecheck-fixture' } }),
  'vendor/pack-a.lock.json': '{}\n',
})) {
  mkdirSync(dirname(join(repo, name)), { recursive: true })
  writeFileSync(join(repo, name), body)
}
git(repo, 'add', '-A')
git(repo, 'commit', '-q', '-m', 'first')
mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
writeFileSync(join(repo, 'node_modules', '.bin', 'typecheck-fixture'), '#!/bin/sh\nprintf typecheck-ok\n')
chmodSync(join(repo, 'node_modules', '.bin', 'typecheck-fixture'), 0o755)
mkdirSync(join(repo, 'vendor', 'pack-a'))
writeFileSync(join(repo, 'vendor', 'pack-a', 'marker'), 'pack\n')
const parentStatusBefore = authoredStatus(repo)

const buildFixture = await startScriptedFixture(req => {
  if (req.opening.trim() === BUILD_PROMPT) {
    if (req.step === 0) {
      return [{ type: 'tool_use', name: 'Bash', input: { command: `pwd; ls -ld node_modules vendor/pack-a; "${BUN}" run typecheck; echo " rc=$?"; git status --porcelain; echo status-end`, description: 'build in the worktree' } }]
    }
    if (req.step === 1) seen.build = req.results[0]
    return [{ type: 'text', text: 'agent done' }]
  }
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'build', prompt: BUILD_PROMPT, isolation: 'worktree' } }]
  if (req.step === 1) seen.isolated = req.results[req.results.length - 1]
  return [{ type: 'text', text: 'done' }]
})
let buildTurn: ScriptedTurn = { result: null, exitCode: null, stderr: '' }
try {
  buildTurn = await runScriptedTurn({ runHome: join(scratch, 'home-build'), cwd: repo, base: buildFixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await buildFixture.close()
}
show("the isolated helper's build", seen.build, buildTurn)
show('the isolated launch', seen.isolated, buildTurn)

tally.section('a worktree-isolated helper can build')
const build = seen.build?.text ?? ''
tally.check('the helper ran in a worktree, not the checkout', build.startsWith(`${scratch}`) && !build.startsWith(`${repo}\n`), build.split('\n')[0])
tally.check("node_modules in the worktree is a link to the checkout's", new RegExp(`node_modules -> ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node_modules`).test(build), build.split('\n').slice(1, 3).join(' | '))
tally.check('…and so is the vendored pack', new RegExp(`vendor/pack-a -> ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/vendor/pack-a`).test(build), build.split('\n').slice(1, 3).join(' | '))
tally.check('bun run typecheck exits 0 there', /typecheck-ok rc=0/.test(build), build)
tally.check('git status in the worktree shows nothing', /rc=0\nstatus-end/.test(build), build)
tally.check('the isolated launch answered without error and the clean worktree was settled', seen.isolated !== undefined && !seen.isolated.isError && !/Worktree kept/.test(seen.isolated.text), seen.isolated?.text.slice(0, 300))
const excludePath = join(repo, '.git', 'info', 'exclude')
const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
tally.check("the checkout's exclude file hides the links", exclude.split('\n').includes('/node_modules') && exclude.split('\n').includes('/vendor/pack-a'), JSON.stringify(exclude))
tally.check("the checkout's own status is unchanged", authoredStatus(repo) === parentStatusBefore, authoredStatus(repo))
tally.check('no worktree is left behind', git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length === 1, git(repo, 'worktree', 'list', '--porcelain'))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
