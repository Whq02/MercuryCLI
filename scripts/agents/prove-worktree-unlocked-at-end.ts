#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-worktree-unlocked-at-end')
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'worktree-unlocked-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const gitTry = (cwd: string, ...args: string[]): { code: number; stderr: string } => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  return { code: run.status ?? -1, stderr: (run.stderr ?? '').trim() }
}
const repo = join(scratch, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'kept.txt'), 'one\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-q', '-m', 'first')

type Lane = { path: string; branch: string | null; locked: string | null }
const lanesOf = (): Lane[] => {
  const out: Lane[] = []
  let current: Lane | null = null
  for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, locked: null }
      if (current.path.includes('/.mercury/worktrees/')) out.push(current)
      continue
    }
    if (current === null) continue
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    if (line === 'locked' || line.startsWith('locked ')) current.locked = line.slice('locked'.length).trim() || '(no reason)'
  }
  return out
}

const ASK = 'two-lanes-probe'
const CLEAN_PROMPT = 'say hello and stop'
const DIRTY_PROMPT = 'leave one file and stop'
const seen: Record<string, SeenResult | undefined> = {}
const fixture = await startScriptedFixture(req => {
  if (req.opening.trim() === CLEAN_PROMPT) return [{ type: 'text', text: 'hello from the clean lane' }]
  if (req.opening.trim() === DIRTY_PROMPT) {
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'printf unsaved > notes.txt', description: 'leave one file' } }]
    return [{ type: 'text', text: 'left notes.txt behind' }]
  }
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Crewmate', input: { description: 'clean helper', prompt: CLEAN_PROMPT, isolation: 'worktree' } }]
  if (req.step === 1) {
    seen.clean = last
    return [{ type: 'tool_use', name: 'Crewmate', input: { description: 'dirty helper', prompt: DIRTY_PROMPT, isolation: 'worktree' } }]
  }
  if (req.step === 2) seen.dirty = last
  return [{ type: 'text', text: 'done' }]
})
let exitCode: number | null = null
let stderr = ''
try {
  const turn = await runScriptedTurn({ runHome: join(scratch, 'home-drive'), cwd: repo, base: fixture.base, ask: ASK, timeoutMs: 300_000, extraArgv: ['--sovereign'] })
  exitCode = turn.exitCode
  stderr = turn.stderr
} finally {
  await fixture.close()
}
const cleanReceipt = seen.clean?.text ?? ''
const dirtyReceipt = seen.dirty?.text ?? ''
console.log(`── the clean launch's receipt (exit ${exitCode ?? '?'}) ──\n${cleanReceipt.split('\n').map(line => `│ ${line}`).join('\n')}`)
console.log(`── the dirty launch's receipt ──\n${dirtyReceipt.split('\n').map(line => `│ ${line}`).join('\n')}`)
const lanes = lanesOf()
console.log(`── lanes after the turn ──\n${lanes.map(lane => `│ ${lane.path} branch=${lane.branch ?? '-'} locked=${lane.locked ?? 'no'}`).join('\n')}`)
const pathIn = (receipt: string): Lane | undefined => lanes.find(lane => receipt.includes(lane.path))
const cleanLane = pathIn(cleanReceipt)
const dirtyLane = pathIn(dirtyReceipt)

tally.section("§1 both helpers answered and each receipt names its own worktree and branch (the owner's rule: nothing is removed automatically)")
tally.check('the clean helper answered without error', seen.clean !== undefined && !seen.clean.isError, cleanReceipt.slice(0, 300) || stderr.slice(-400))
tally.check('the dirty helper answered without error', seen.dirty !== undefined && !seen.dirty.isError, dirtyReceipt.slice(0, 300) || stderr.slice(-400))
tally.check('two agent lanes are registered after the turn, both still on disk', lanes.length === 2 && lanes.every(lane => existsSync(lane.path)), JSON.stringify(lanes))
tally.check("the clean receipt names its worktree's path and branch", cleanLane !== undefined && cleanLane.branch !== null && new RegExp(`\\(branch ${cleanLane.branch}( @ [0-9a-f]{7,})?\\)`).test(cleanReceipt), cleanReceipt.slice(0, 400))
tally.check("the dirty receipt names its worktree's path and branch and what it holds", dirtyLane !== undefined && dirtyLane.branch !== null && new RegExp(`\\(branch ${dirtyLane.branch}( @ [0-9a-f]{7,})?\\)`).test(dirtyReceipt) && /notes\.txt/.test(dirtyReceipt) && /never removed by the machine/.test(dirtyReceipt), dirtyReceipt.slice(0, 400))
tally.check('the dirty lane still holds the file the helper left', dirtyLane !== undefined && existsSync(join(dirtyLane.path, 'notes.txt')))

tally.section("§2 the creation lock ends with the crewmate: a finished lane is not locked, so the lead's own git worktree remove is not refused")
tally.check('the clean lane carries no lock after its crewmate ended', cleanLane !== undefined && cleanLane.locked === null, cleanLane ? `locked: ${cleanLane.locked}` : 'no clean lane')
tally.check('the dirty lane carries no lock after its crewmate ended', dirtyLane !== undefined && dirtyLane.locked === null, dirtyLane ? `locked: ${dirtyLane.locked}` : 'no dirty lane')
const removal = cleanLane ? gitTry(repo, 'worktree', 'remove', cleanLane.path) : { code: -1, stderr: 'no clean lane' }
tally.check('an ordinary `git worktree remove <path>` of the clean lane succeeds (no force, no unlock by hand)', removal.code === 0 && cleanLane !== undefined && !existsSync(cleanLane.path), `exit ${removal.code}: ${removal.stderr}`)
const guarded = dirtyLane ? gitTry(repo, 'worktree', 'remove', dirtyLane.path) : { code: -1, stderr: 'no dirty lane' }
tally.check("git's own guard, not a stale lock, is what stands between the lead and the dirty lane (remove without force refuses on the untracked file)", guarded.code !== 0 && /modified or untracked files/.test(guarded.stderr) && !/locked working tree/.test(guarded.stderr), `exit ${guarded.code}: ${guarded.stderr}`)

tally.section("§3 the Crewmate tool's words say the rule: the worktree survives unlocked, path and branch in the result, the janitor's safe removal — never a promise of self-cleanup")
{
  const prompt = readFileSync(join(ROOT, 'src/tools/AgentTool/prompt.ts'), 'utf8')
  tally.check('the description no longer promises that an untouched worktree cleans itself up', !prompt.includes('cleans itself up'), 'prompt.ts still says "cleans itself up"')
  tally.check('the description says nothing is removed automatically and the worktree survives unlocked with its path and branch in the result', /Nothing is removed automatically/.test(prompt) && /survives the crewmate's end unlocked/.test(prompt) && /path and branch riding back in the result/.test(prompt), 'the rule is not in the description')
  tally.check("the description names the seven-day janitor's safe removal", /seven-day janitor removes only a clean one whose commits are reachable/.test(prompt), 'the janitor line is missing')
}

rmSync(scratch, { recursive: true, force: true })
tally.finish()
