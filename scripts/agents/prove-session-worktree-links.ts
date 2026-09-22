#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
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
const { createWorktreeForSession, getCurrentWorktreeSession, keepWorktree } = await import('../../src/utils/worktree.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'session-worktree-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const authoredStatus = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall').split('\n').filter(line => line !== '' && !line.slice(3).startsWith('.mercury/')).join('\n')
const isLinkTo = (path: string, target: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(target)
  } catch {
    return false
  }
}

const repo = join(scratch, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, 'init', '-q', '-b', 'main')
for (const [name, body] of Object.entries({
  '.gitignore': 'node_modules/\nvendor/*/\n',
  'package.json': JSON.stringify({ name: 'session-worktree-fixture', scripts: { typecheck: 'typecheck-fixture' } }),
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
mkdirSync(join(repo, 'authored'))
writeFileSync(join(repo, 'authored', 'note'), 'not ignored\n')
const parentStatusBefore = authoredStatus(repo)

process.chdir(repo)
state.setOriginalCwd(repo)
state.setCwdState(repo)
state.setIsInteractive(true)
config.enableConfigs()

section("§1 the session road cuts a worktree that comes ready to build")
const session = await createWorktreeForSession('proof-session', 'links-proof')
check('the worktree lives under the repository worktrees home', session.worktreePath.startsWith(join(repo, '.mercury', 'worktrees')) && existsSync(join(session.worktreePath, 'package.json')), session.worktreePath)
check('the session slot names it', getCurrentWorktreeSession()?.worktreePath === session.worktreePath)
check("node_modules is a link to the checkout's", isLinkTo(join(session.worktreePath, 'node_modules'), join(repo, 'node_modules')))
check('the vendored pack is a link too', isLinkTo(join(session.worktreePath, 'vendor', 'pack-a'), join(repo, 'vendor', 'pack-a')))
check('an authored untracked directory of the checkout is not linked', !existsSync(join(session.worktreePath, 'authored')))
const laneStatus = git(session.worktreePath, 'status', '--porcelain')
check('git status in the worktree shows nothing', laneStatus === '', laneStatus)
check("the checkout's own status is unchanged", authoredStatus(repo) === parentStatusBefore, authoredStatus(repo))
const excludePath = join(repo, '.git', 'info', 'exclude')
const excludeLines = (existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '').split('\n')
check("the clone's exclude file carries the link names, anchored, once each", excludeLines.filter(l => l === '/node_modules').length === 1 && excludeLines.filter(l => l === '/vendor/pack-a').length === 1, excludeLines.join('|'))
let typecheck = ''
try {
  typecheck = execFileSync(process.execPath, ['run', 'typecheck'], { cwd: session.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  typecheck = `failed: ${String((error as { stderr?: string }).stderr ?? error)}`
}
check('bun run typecheck exits 0 in the worktree', typecheck.includes('typecheck-ok'), typecheck.slice(0, 200))

section('§2 a second worktree of the same checkout is linked the same way, with no duplicate exclude line')
await keepWorktree()
check('the slot is clear after keeping the first', getCurrentWorktreeSession() === null)
const second = await createWorktreeForSession('proof-session', 'links-proof-2')
check('the second worktree is linked too', isLinkTo(join(second.worktreePath, 'node_modules'), join(repo, 'node_modules')) && isLinkTo(join(second.worktreePath, 'vendor', 'pack-a'), join(repo, 'vendor', 'pack-a')), second.worktreePath)
const excludeAgain = readFileSync(excludePath, 'utf8').split('\n')
check('the exclude file still carries each name once', excludeAgain.filter(l => l === '/node_modules').length === 1 && excludeAgain.filter(l => l === '/vendor/pack-a').length === 1, excludeAgain.join('|'))
check('git status in the second worktree shows nothing', git(second.worktreePath, 'status', '--porcelain') === '')
await keepWorktree()

section('§3 every session road hands its source directory to the setup')
const source = readFileSync(join(ROOT, 'src/utils/worktree.ts'), 'utf8')
check('the session road (EnterWorktree and the --worktree boot) links from the directory it was opened in', source.includes('await runPostCreationSetup(gitRoot, created.worktreePath, originalCwd)'))
check('the --worktree --tmux fast path links from the directory it was opened in', source.includes('await runPostCreationSetup(gitRoot, created.worktreePath, getCwd())'))
check('the agent road is unchanged', source.includes('await runPostCreationSetup(gitRoot, created.worktreePath, from)'))
const sessionsDoc = readFileSync(join(ROOT, 'docs/SESSIONS.md'), 'utf8').replace(/\s+/g, ' ')
check('the sessions page says an install inside the worktree lands in the checkout', sessionsDoc.includes('an install run inside the worktree installs into the checkout'))

process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
