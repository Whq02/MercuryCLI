#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
process.env.MERCURY_WORKTREE_CLONE = 'off'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const { toAgentId } = await import('../../src/types/ids.ts')
const worktree = await import('../../src/utils/worktree.ts')
const reminder = await import('../../src/utils/crew/crewWorktreeReminder.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

const DAY = 86_400_000
const MARKER = 'WORKTREE_LANE'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-janitor-real-id-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const age = (path: string, days: number): void => {
  const then = new Date(Date.now() - days * DAY)
  utimesSync(path, then, then)
}
const realSlug = (): string => {
  for (;;) {
    const id = generateTaskId('local_agent')
    if (toAgentId(id) !== null && /[g-z]/.test(id.slice(1, 8))) return `agent-${id.slice(0, 8)}`
  }
}
const adminOf = (path: string): string => resolve(path, readFileSync(join(path, '.git'), 'utf8').trim().slice('gitdir:'.length).trim())
const marked = (path: string): boolean => existsSync(join(adminOf(path), MARKER))
const lanes = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
const sweep = (repo: string): Promise<number> => runWithCwdOverride(repo, () => worktree.cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * DAY)))
const cut = (repo: string, slug: string): ReturnType<typeof worktree.createAgentWorktree> => worktree.createAgentWorktree(slug, { from: repo })
const settle = async (repo: string, path: string, days: number): Promise<void> => {
  await worktree.unlockAgentWorktree(path, repo)
  age(path, days)
}

try {
  const repo = join(scratch, 'repo')
  const remote = join(scratch, 'remote.git')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '.mercury/\n')
  writeFileSync(join(repo, 'kept.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  git(scratch, 'init', '-q', '--bare', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin')
  process.chdir(repo)
  state.setOriginalCwd(repo)
  state.setCwdState(repo)
  state.setIsInteractive(true)
  config.enableConfigs()

  section('§1 a lane named as the Crewmate tool names it carries a marker in its git admin folder, and nothing in the worktree')
  const cleanSlug = realSlug()
  const dirtySlug = realSlug()
  const diedSlug = realSlug()
  console.log(`  the lanes: ${cleanSlug} (clean), ${dirtySlug} (an uncommitted file), ${diedSlug} (its marker never written)`)
  check('the names are a real crewmate\'s, with a letter past f in them', [cleanSlug, dirtySlug, diedSlug].every(slug => /^agent-a[0-9a-z]{7}$/.test(slug) && /[g-z]/.test(slug.slice(7))) && new Set([cleanSlug, dirtySlug, diedSlug]).size === 3)
  const clean = await cut(repo, cleanSlug)
  const dirty = await cut(repo, dirtySlug)
  const died = await cut(repo, diedSlug)
  const hex = await cut(repo, 'agent-a0000001')
  const hexOld = await cut(repo, 'agent-a00000ff')
  check('the marker stands in the admin folder of each, naming the lane', [clean, dirty, died, hex].every(lane => marked(lane.worktreePath)) && readFileSync(join(adminOf(clean.worktreePath), MARKER), 'utf8') === `agent ${cleanSlug}\n`, [clean, dirty, died, hex].map(lane => marked(lane.worktreePath)).join(', '))
  check('nothing is added to the worktree itself, and git sees nothing to commit there', readdirSync(clean.worktreePath).sort().join(',') === '.git,.gitignore,.mercury,kept.txt' && git(clean.worktreePath, 'status', '--porcelain') === '', readdirSync(clean.worktreePath).sort().join(','))
  writeFileSync(join(dirty.worktreePath, 'draft.txt'), 'not committed\n')
  rmSync(join(adminOf(died.worktreePath), MARKER), { force: true })
  rmSync(join(adminOf(hexOld.worktreePath), MARKER), { force: true })

  section('§2 a worktree a person named, and the machine\'s other lanes')
  const session = await worktree.createWorktreeForSession(state.getSessionId(), 'agent-analysis', undefined, { gitRoot: repo })
  worktree.restoreWorktreeSession(null)
  const byHand = join(repo, '.mercury', 'worktrees', 'agent-accounts')
  git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-accounts', byHand, 'HEAD')
  const flow = await cut(repo, 'wf-1')
  const bridge = await cut(repo, 'bridge-demo')
  check('a worktree a person named agent-analysis through the session road carries no marker', existsSync(session.worktreePath) && !marked(session.worktreePath))
  check('a workflow lane and a bridge lane carry none either: only a crewmate\'s lane is marked', !marked(flow.worktreePath) && !marked(bridge.worktreePath))
  for (const path of [clean.worktreePath, dirty.worktreePath, died.worktreePath, hex.worktreePath, hexOld.worktreePath, flow.worktreePath, bridge.worktreePath]) await settle(repo, path, 9)
  age(session.worktreePath, 400)
  age(byHand, 400)

  section('§3 the list of worktrees crewmates left')
  const left = await reminder.crewLeftoverWorktrees(repo, Date.now())
  const states = Object.fromEntries(left.map(lane => [resolve(lane.path), lane.state]))
  check('a marked lane with a real id is listed: clean with the day the janitor takes it, or never removed by the machine', states[clean.worktreePath] === 'clean' && states[dirty.worktreePath] === 'uncommitted' && left.some(lane => resolve(lane.path) === clean.worktreePath && /seven-day janitor removes it on \d{4}-\d{2}-\d{2}/.test(reminder.crewWorktreeReminderLine(lane, Date.now()))), JSON.stringify(states))
  check('the two worktrees a person named are not listed as a crewmate\'s', states[session.worktreePath] === undefined && states[byHand] === undefined, JSON.stringify(states))
  check('a lane with a real id and no marker is not listed; a hex name is, marker or not, as before', states[died.worktreePath] === undefined && states[hex.worktreePath] === 'clean' && states[hexOld.worktreePath] === 'clean', JSON.stringify(states))

  section('§4 the seven-day janitor')
  const removed = await sweep(repo)
  const there = (path: string): boolean => existsSync(path) && lanes(repo).includes(path)
  check('the aged clean lane with a real id and the marker is removed, its branch with it', !existsSync(clean.worktreePath) && !lanes(repo).includes(clean.worktreePath) && git(repo, 'branch', '--list', worktree.worktreeBranchName(cleanSlug)) === '', `still on disk ${existsSync(clean.worktreePath)}`)
  check('the marked lane with an uncommitted file survives, file and all', there(dirty.worktreePath) && existsSync(join(dirty.worktreePath, 'draft.txt')))
  check('a worktree a person named agent-analysis, clean, reachable and 400 days old, is never taken', there(session.worktreePath) && git(repo, 'branch', '--list', 'worktree-agent-analysis') !== '', `on disk ${existsSync(session.worktreePath)}`)
  check('…nor one made by hand under the same kind of name', there(byHand) && git(repo, 'branch', '--list', 'worktree-agent-accounts') !== '', `on disk ${existsSync(byHand)}`)
  check('a lane whose marker was never written stays, clean and aged as it is', there(died.worktreePath), `on disk ${existsSync(died.worktreePath)}`)
  check('a hex-named lane is removed as before, with the marker and without', !existsSync(hex.worktreePath) && !existsSync(hexOld.worktreePath))
  check('a workflow lane and a bridge lane, clean and pushed, are removed as before', !existsSync(flow.worktreePath) && !existsSync(bridge.worktreePath))
  check('five worktrees were removed in all', removed === 5, String(removed))
  check('a second pass takes none of the survivors', (await sweep(repo)) === 0 && there(session.worktreePath) && there(byHand) && there(died.worktreePath) && there(dirty.worktreePath))

  section('§5 where it is decided')
  const isAgentLane = (worktree as unknown as { isAgentLane?: (slug: string, path: string) => Promise<boolean> }).isAgentLane
  const answers = isAgentLane === undefined ? null : await Promise.all([isAgentLane(dirtySlug, dirty.worktreePath), isAgentLane(diedSlug, died.worktreePath), isAgentLane('agent-analysis', session.worktreePath), isAgentLane('agent-a0000001', join(repo, 'nowhere')), isAgentLane('agent-review', dirty.worktreePath), isAgentLane('agent-AE8QC602', dirty.worktreePath), isAgentLane(`${dirtySlug}9`, dirty.worktreePath)])
  check('one predicate: a real id with the marker yes; without it no; a person\'s name no; a hex name yes with no folder at all; any other name no', JSON.stringify(answers) === JSON.stringify([true, false, false, true, false, false, false]), JSON.stringify(answers))
  const source = readFileSync(join(ROOT, 'src/utils/worktree.ts'), 'utf8')
  const reminderSource = readFileSync(join(ROOT, 'src/utils/crew/crewWorktreeReminder.ts'), 'utf8')
  check('the janitor and the leftover list both ask it', source.includes('const agentLane = await isAgentLane(slug, candidatePath)') && reminderSource.includes('if (!(await isAgentLane(slug, path))) continue') && !reminderSource.includes('AGENT_LANE_SLUG'))
  check('the marker is written first, as soon as git has made the lane', source.includes('  if (!created.existed) {\n    await markAgentLane(created.worktreePath, slug)\n'))
  check('the hex pattern is the one the base had', source.includes('const AGENT_LANE_SLUG = /^agent-a[0-9a-f]{7,32}$/'))
} finally {
  delete process.env.MERCURY_WORKTREE_CLONE
  process.chdir(ROOT)
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
