#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const wt = await import('../../src/utils/worktree.ts')
const reminder = await import('../../src/utils/crew/crewWorktreeReminder.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

{
  const z = [
    ' M src/a.ts',
    'R  new.ts', 'old.ts',
    '?? notes.md',
    '?? .mercury/cache-clock/sessions/x.json',
    '?? .othertool/cache-clock/sessions/y.json',
  ].join('\0') + '\0'
  const c = wt.classifyPorcelainRecords(z)
  check('§A tracked: modify + rename both sides', c.tracked.length === 3)
  check('§A authored untracked separated: a foreign-named dir is a project file, never Mercury-ephemeral', c.untrackedAuthored.length === 2 && c.untrackedAuthored.includes('notes.md'))
  check('§A Mercury cache-clock debris classes as Mercury-ephemeral', c.mercuryEphemeral.length === 1)
}

function mkRepo(): { repo: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'unison-w2-repo-')))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'w2@fixture')
  git(repo, 'config', 'user.name', 'w2')
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'seed')
  return { repo }
}
type Lane = { lane: string; branch: string; slug: string }
let laneN = 0
function mkLane(repo: string): Lane {
  const slug = `agent-a${String(++laneN).padStart(7, '0')}`
  const branch = wt.worktreeBranchName(slug)
  const lane = join(repo, '.mercury', 'worktrees', slug)
  git(repo, 'worktree', 'add', '-q', '-b', branch, lane, 'HEAD')
  return { lane, branch, slug }
}
const DAY = 86_400_000
const read = (repo: string, at: Lane) =>
  reminder.crewWorktreeLeftoverOf({ name: at.slug, path: at.lane, branch: at.branch, gitRoot: repo }, Date.now())
const sweep = (repo: string, lane?: string): Promise<number> => {
  const old = new Date(Date.now() - 9 * DAY)
  if (lane !== undefined && existsSync(lane)) utimesSync(lane, old, old)
  return runWithCwdOverride(repo, () => wt.cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * DAY)))
}
const branchThere = (repo: string, branch: string): boolean => {
  try {
    git(repo, 'rev-parse', '--verify', branch)
    return true
  } catch {
    return false
  }
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  mkdirSync(join(at.lane, '.mercury', 'cache-clock', 'sessions'), { recursive: true })
  writeFileSync(join(at.lane, '.mercury', 'cache-clock', 'sessions', 's.json'), '{}\n')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§B runtime-only lane SETTLES', left.state === 'clean' && taken === 1, `${left.state} · ${taken} taken`)
  check('§B worktree absent', !existsSync(at.lane))
  check('§B branch absent', !branchThere(repo, at.branch))
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§C pristine lane settles', left.state === 'clean' && taken === 1 && !existsSync(at.lane), `${left.state} · ${taken} taken`)
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'work.ts'), 'x\n')
  git(at.lane, 'add', '.')
  git(at.lane, 'commit', '-q', '-m', 'authored')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§D commit preserves', left.state === 'unreachable' && taken === 0 && existsSync(at.lane), `${left.state} · ${taken} taken`)
  check('§D named', left.detail.includes('1 commit'), left.detail)
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'README.md'), 'edited\n')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§E tracked edit preserves + names the path', left.state === 'uncommitted' && left.detail.includes('README.md') && taken === 0 && existsSync(at.lane), `${left.state} · ${left.detail} · ${taken} taken`)
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'idea.txt'), 'x')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§F one-byte authored file preserved AND named', left.state === 'uncommitted' && left.detail.includes('idea.txt') && taken === 0, `${left.state} · ${left.detail} · ${taken} taken`)
  check('§F lane + branch still present', existsSync(at.lane) && branchThere(repo, at.branch))
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'notes.md'), 'keep me\n')
  mkdirSync(join(at.lane, '.mercury', 'cache-clock', 'sessions'), { recursive: true })
  writeFileSync(join(at.lane, '.mercury', 'cache-clock', 'sessions', 's.json'), '{}\n')
  const left = await read(repo, at)
  const delta = await wt.readWorktreeDelta(at.lane)
  const taken = await sweep(repo, at.lane)
  check('§G mixed preserves', left.state === 'uncommitted' && taken === 0 && existsSync(at.lane), `${left.state} · ${taken} taken`)
  check(
    '§G delta separates authored from runtime',
    delta.untrackedAuthored.includes('notes.md') &&
      delta.mercuryEphemeral.some(p => p.includes('cache-clock')) &&
      left.detail.includes('notes.md') &&
      !left.detail.includes('cache-clock'),
    left.detail,
  )
}

{
  const dir = mkdtempSync(join(tmpdir(), 'unison-w2-notgit-'))
  const d = await wt.readWorktreeDelta(dir)
  check('§H non-repo dir ⇒ uncertainty (never a clean-looking delta)', d.uncertainty !== null)
  const left = await reminder.crewWorktreeLeftoverOf({ name: 'not-git', path: dir }, Date.now())
  check('§H a folder git does not own reads unowned, never clean', left.state === 'unowned', left.state)
}

{
  const { repo } = mkRepo()
  const gone = join(tmpdir(), `unison-w2-gone-${Date.now()}`)
  const left = await reminder.crewWorktreeLeftoverOf({ name: 'gone', path: gone, branch: 'none', gitRoot: repo }, Date.now())
  const taken = await sweep(repo)
  check('§I missing lane is not a silent success', left.state !== 'clean' && taken === 0, `${left.state} · ${taken} taken`)
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  const first = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  const second = await read(repo, at)
  const again = await sweep(repo, at.lane)
  check(
    '§J second settle is visible non-success (idempotent-safe)',
    first.state === 'clean' && taken === 1 && second.state !== 'clean' && again === 0,
    `${first.state} · ${taken} taken · ${second.state} · ${again} taken`,
  )
}

{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dir, '../..')
  const agentTool = readFileSync(join(root, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  check(
    '§L the Crewmate tool keeps every crewmate worktree and reads it through the reminder owner',
    !('settleAgentWorktree' in wt) &&
      !agentTool.includes('cleanupStaleAgentWorktrees(') &&
      !agentTool.includes('cleanupWorktree(') &&
      agentTool.includes('crewWorktreeLeftoverOf('),
  )
  check(
    '§L the Crewmate tool does not hand-roll the old boolean+remove pair',
    !agentTool.includes('hasWorktreeChanges('),
  )
}

{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dir, '../..')
  const janitor = readFileSync(join(root, 'src/utils/worktree.ts'), 'utf8')
  check(
    '§M the janitor classifies via the same delta (the -uno split is gone)',
    janitor.includes('deltaBlocksSettlement(delta)') && !janitor.includes("'-uno'"),
  )
}

if (process.platform === 'win32') {
  const { symlinkSync, openSync, closeSync } = await import('node:fs')
  {
    const { repo } = mkRepo()
    const at = mkLane(repo)
    const junction = join(mkdtempSync(join(tmpdir(), 'unison-w2-junc-')), 'via')
    symlinkSync(at.lane, junction, 'junction')
    const left = await read(repo, { ...at, lane: junction })
    check('§N1 junction-reached pristine lane reads clean (a typed state — never silent)', left.state === 'clean', left.state)
  }
  {
    const { repo } = mkRepo()
    const at = mkLane(repo)
    const fd = openSync(join(at.lane, 'README.md'), 'r')
    const taken = await sweep(repo, at.lane)
    check(
      '§N2 open-handle settlement is typed, never a silent success claim',
      (taken === 1 && !existsSync(at.lane)) || (taken === 0 && existsSync(at.lane)),
      `${taken} taken`,
    )
    closeSync(fd)
    if (taken !== 1) {
      const again = await sweep(repo, at.lane)
      check('§N2 settlement completes once the handle releases', again === 1 && !existsSync(at.lane), `${again} taken`)
    }
  }
} else {
  console.log('  [SKIP] §N windows path/handle legs (posix host — the windows-functional lane runs them)')
}

console.log(failed === 0 ? '\n ✅ WORKTREE SETTLEMENT LAWS HOLD' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
