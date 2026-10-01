#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-crew-cleanup-reminds')
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'crew-cleanup-reminds-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const DAY = 86_400_000
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'kept.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
}
const age = (path: string, days: number): void => {
  const then = new Date(Date.now() - days * DAY)
  utimesSync(path, then, then)
}
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const worktree = await import('../../src/utils/worktree.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

tally.section('§1 the reminder owner: a leftover worktree is named with its age, what is in it, and the day the seven-day janitor takes it — or that the machine never will')
const repo = join(scratch, 'repo')
initRepo(repo)
const cut = async (slug: string) => worktree.createAgentWorktree(slug, { from: repo })
const clean = await cut('agent-a0000001')
const dirty = await cut('agent-a0000002')
writeFileSync(join(dirty.worktreePath, 'notes.txt'), 'unsaved work\n')
const ahead = await cut('agent-a0000003')
writeFileSync(join(ahead.worktreePath, 'kept.txt'), 'two\n')
git(ahead.worktreePath, 'commit', '-qam', 'only here')
type Reminder = typeof import('../../src/utils/crew/crewWorktreeReminder.ts')
let reminder: Reminder | null = null
try {
  reminder = await import('../../src/utils/crew/crewWorktreeReminder.ts')
} catch (error) {
  tally.check('the reminder owner exists (src/utils/crew/crewWorktreeReminder.ts)', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
}
const now = Date.now()
if (reminder !== null) {
  const a = await reminder.crewWorktreeLeftoverOf({ name: 'mate-a', path: clean.worktreePath, branch: clean.worktreeBranch, gitRoot: clean.gitRoot }, now)
  tally.check('a clean lane on reachable commits reads clean, and names the day the janitor takes it (seven days after its last change)', a.state === 'clean' && Math.abs(a.janitorAt - (a.changedAt + reminder.CREW_JANITOR_DAYS * DAY)) < 1000, JSON.stringify(a))
  const b = await reminder.crewWorktreeLeftoverOf({ name: 'mate-b', path: dirty.worktreePath, branch: dirty.worktreeBranch, gitRoot: dirty.gitRoot }, now)
  tally.check('a lane with an untracked file reads uncommitted and names the file', b.state === 'uncommitted' && b.detail.includes('notes.txt'), JSON.stringify(b))
  const c = await reminder.crewWorktreeLeftoverOf({ name: 'mate-c', path: ahead.worktreePath, branch: ahead.worktreeBranch, gitRoot: ahead.gitRoot }, now)
  tally.check('a lane with a commit reachable from no other branch reads unreachable and counts it', c.state === 'unreachable' && /1 commit/.test(c.detail), JSON.stringify(c))
  const lineA = reminder.crewWorktreeReminderLine(a, now)
  const lineB = reminder.crewWorktreeReminderLine(b, now)
  const lineC = reminder.crewWorktreeReminderLine(c, now)
  tally.check('the clean row names the crewmate, the path and the janitor day', lineA.includes('mate-a') && lineA.includes(clean.worktreePath) && /seven-day janitor/.test(lineA), lineA)
  tally.check('the uncommitted and the unreachable rows say the machine never removes them', /never removed by the machine/.test(lineB) && /never removed by the machine/.test(lineC), `${lineB}\n${lineC}`)
  const all = await reminder.crewLeftoverWorktrees(repo, now)
  tally.check('the leftover list names every agent lane of the repository with its state', all.length === 3 && all.map(l => l.state).sort().join(',') === 'clean,uncommitted,unreachable', JSON.stringify(all.map(l => `${l.path}:${l.state}`)))
}

tally.section("§2 a crewmate's end keeps its worktree and reminds: the Agent tool's cleanup no longer settles (removes) a clean lane")
{
  const tool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  tally.check('the Agent tool no longer calls the removing settle', !tool.includes('settleAgentWorktree('), 'AgentTool.tsx still calls settleAgentWorktree')
  tally.check("the completed receipt's worktree line is the reminder owner's row", tool.includes('crewWorktreeReminderTail('), 'the receipt does not use the reminder words')
}
const driveRepo = join(scratch, 'drive-repo')
initRepo(driveRepo)
const ASK = 'isolate-probe'
const HELPER_PROMPT = 'say hello and stop'
const seen: Record<string, SeenResult | undefined> = {}
const fixture = await startScriptedFixture(req => {
  if (req.opening.trim() === HELPER_PROMPT) return [{ type: 'text', text: 'hello from the lane' }]
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Agent', input: { description: 'isolated helper', prompt: HELPER_PROMPT, isolation: 'worktree' } }]
  if (req.step === 1) seen.isolated = last
  return [{ type: 'text', text: 'done' }]
})
let exitCode: number | null = null
let stderr = ''
try {
  const turn = await runScriptedTurn({ runHome: join(scratch, 'home-drive'), cwd: driveRepo, base: fixture.base, ask: ASK, timeoutMs: 240_000, extraArgv: ['--sovereign'] })
  exitCode = turn.exitCode
  stderr = turn.stderr
} finally {
  await fixture.close()
}
const receipt = seen.isolated?.text ?? ''
console.log(`── the isolated launch's receipt (exit ${exitCode ?? '?'}) ──\n${receipt.split('\n').map(line => `│ ${line}`).join('\n')}`)
const lanes = (() => {
  try {
    return git(driveRepo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ') && line.includes('/.mercury/worktrees/')).map(line => line.slice('worktree '.length))
  } catch {
    return []
  }
})()
tally.check('the isolated helper answered without error', seen.isolated !== undefined && !seen.isolated.isError, receipt.slice(0, 300) || stderr.slice(-400))
tally.check("the helper's clean worktree is still on disk after its end (nothing is deleted automatically)", lanes.length === 1 && existsSync(lanes[0]!), JSON.stringify(lanes))
tally.check('the receipt reminds the lead: the worktree kept, the path, and the day the seven-day janitor takes it', /Worktree kept: /.test(receipt) && lanes.length === 1 && receipt.includes(lanes[0]!) && /seven-day janitor/.test(receipt), receipt.slice(0, 400))

tally.section('§3 the janitor removes an aged agent lane ONLY when nothing would be lost — committed, reachable in the repository, no untracked file; the rest survive on the reminder')
const jRepo = join(scratch, 'janitor-repo')
initRepo(jRepo)
const jCut = async (slug: string) => worktree.createAgentWorktree(slug, { from: jRepo })
const jClean = await jCut('agent-a0000011')
const jDirty = await jCut('agent-a0000012')
writeFileSync(join(jDirty.worktreePath, 'draft.txt'), 'not committed\n')
const jAhead = await jCut('agent-a0000013')
writeFileSync(join(jAhead.worktreePath, 'kept.txt'), 'three\n')
git(jAhead.worktreePath, 'commit', '-qam', 'reachable from nowhere else')
for (const lane of [jClean, jDirty, jAhead]) age(lane.worktreePath, 10)
const removed = await runWithCwdOverride(jRepo, () => worktree.cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * DAY)))
tally.check('an aged clean lane whose commits are reachable in the repository (on main; no remote needed) is removed', removed === 1 && !existsSync(jClean.worktreePath), `removed ${removed}; clean lane present: ${existsSync(jClean.worktreePath)}`)
tally.check('an aged lane with an uncommitted file survives', existsSync(jDirty.worktreePath) && existsSync(join(jDirty.worktreePath, 'draft.txt')))
tally.check('an aged lane with a commit reachable from no other branch survives', existsSync(jAhead.worktreePath) && git(jAhead.worktreePath, 'log', '--oneline').includes('reachable from nowhere else'))
if (reminder !== null) {
  const left = await reminder.crewLeftoverWorktrees(jRepo, Date.now())
  const states = Object.fromEntries(left.map(l => [l.path, l.state]))
  tally.check('the reminder names the two survivors with why the machine never removes them', states[jDirty.worktreePath] === 'uncommitted' && states[jAhead.worktreePath] === 'unreachable' && left.every(l => /never removed by the machine/.test(reminder!.crewWorktreeReminderLine(l, Date.now()))), JSON.stringify(left))
  tally.check('…and each with its age', left.every(l => /\b10 days?\b|\b1 week/.test(reminder!.crewWorktreeReminderLine(l, Date.now()))), left.map(l => reminder!.crewWorktreeReminderLine(l, Date.now())).join('\n'))
}
{
  const source = readFileSync(join(ROOT, 'src/utils/worktree.ts'), 'utf8')
  tally.check("the workflow lanes' path is byte-identical: the remote probe still guards wf_/parcel-/bridge-/job- slugs", source.includes("runGit(['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'], candidatePath)") && source.includes('if (deltaBlocksSettlement(delta)) continue'), 'the workflow path moved')
}

rmSync(scratch, { recursive: true, force: true })
tally.finish()
