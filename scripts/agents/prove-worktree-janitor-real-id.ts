#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-janitor-real-id-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
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
const lanes = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))

try {
  const repo = join(scratch, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '.mercury/\n')
  writeFileSync(join(repo, 'kept.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  process.chdir(repo)
  state.setOriginalCwd(repo)
  state.setCwdState(repo)
  state.setIsInteractive(true)
  config.enableConfigs()

  section('§1 a lane named as the Crewmate tool names it: agent- and the first eight characters of a crewmate\'s id')
  const cleanSlug = realSlug()
  const dirtySlug = realSlug()
  console.log(`  the two lanes: ${cleanSlug} and ${dirtySlug}`)
  check('the names are a real crewmate\'s, with a letter past f in them', /^agent-a[0-9a-z]{7}$/.test(cleanSlug) && /[g-z]/.test(cleanSlug.slice(7)) && cleanSlug !== dirtySlug)
  const clean = await worktree.createAgentWorktree(cleanSlug, { from: repo })
  const dirty = await worktree.createAgentWorktree(dirtySlug, { from: repo })
  writeFileSync(join(dirty.worktreePath, 'draft.txt'), 'not committed\n')
  const named = await worktree.createAgentWorktree('agent-review', { from: repo })
  for (const lane of [clean, dirty, named]) {
    await worktree.unlockAgentWorktree(lane.worktreePath, repo)
    age(lane.worktreePath, 9)
  }

  section('§2 the list of worktrees crewmates left names them')
  const left = await reminder.crewLeftoverWorktrees(repo, Date.now())
  const states = Object.fromEntries(left.map(lane => [lane.path, lane.state]))
  check('a clean lane with a real id is listed, clean, with the day the janitor takes it', states[clean.worktreePath] === 'clean' && left.some(lane => lane.path === clean.worktreePath && /seven-day janitor removes it on \d{4}-\d{2}-\d{2}/.test(reminder.crewWorktreeReminderLine(lane, Date.now()))), JSON.stringify(states))
  check('a lane with a real id that holds an uncommitted file is listed as never removed by the machine', states[dirty.worktreePath] === 'uncommitted' && left.some(lane => lane.path === dirty.worktreePath && reminder.crewWorktreeReminderLine(lane, Date.now()).includes(reminder.CREW_WORKTREE_NEVER_REMOVED)), JSON.stringify(states))
  check('a worktree a person named agent-review is not a crewmate\'s lane', states[named.worktreePath] === undefined)

  section('§3 the seven-day janitor takes the clean one, and only it')
  const removed = await runWithCwdOverride(repo, () => worktree.cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * DAY)))
  check('the aged clean lane with a real id is removed, its branch with it', removed === 1 && !existsSync(clean.worktreePath) && !lanes(repo).includes(clean.worktreePath) && git(repo, 'branch', '--list', worktree.worktreeBranchName(cleanSlug)) === '', `removed ${removed}; still on disk ${existsSync(clean.worktreePath)}`)
  check('the lane with an uncommitted file survives, file and all', existsSync(join(dirty.worktreePath, 'draft.txt')) && lanes(repo).includes(dirty.worktreePath))
  check('the worktree a person named survives', existsSync(named.worktreePath) && lanes(repo).includes(named.worktreePath))

  section('§4 the one pattern')
  const pattern = (worktree as unknown as { AGENT_LANE_SLUG?: RegExp }).AGENT_LANE_SLUG
  const takes = (name: string): boolean => pattern !== undefined && pattern.test(name)
  check('it takes a crewmate\'s lane as named today and as named before', takes('agent-ae8qc602') && takes('agent-a0000001') && takes('agent-a1b2c3d4e5f6'))
  check('it takes no other name', !takes('agent-review') && !takes('agent-ae8qc6029') && !takes('agent-ae8qc60') && !takes('agent-AE8QC602') && !takes('agent-be8qc602') && !takes('xagent-ae8qc602') && !takes('agent-ae8qc602/x'))
  const reminderSource = readFileSync(join(ROOT, 'src/utils/crew/crewWorktreeReminder.ts'), 'utf8')
  check('the leftover list reads the janitor\'s own pattern, not a second copy of it', reminderSource.includes("import { AGENT_LANE_SLUG, worktreeBranchName, worktreeRemovalSafe } from '../worktree.js'") && !reminderSource.includes('const AGENT_LANE_SLUG'))
} finally {
  delete process.env.MERCURY_WORKTREE_CLONE
  process.chdir(ROOT)
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
