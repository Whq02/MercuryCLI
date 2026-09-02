#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-proof-home-key-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'unused-home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

console.log('============================================================')
console.log(' proof home — the seeded slice is the one the product reads')
console.log('============================================================')

const { seedFirstRun, canonicalProjectKeyOf } = await import('../lib/firstRunSeed.ts')
const { findCanonicalGitRoot } = await import('../../src/utils/git.ts')

const main = join(SCRATCH, 'main')
const lane = join(SCRATCH, 'lane')
const plain = join(SCRATCH, 'plain')
mkdirSync(main, { recursive: true })
mkdirSync(plain, { recursive: true })
git(main, 'init', '-q', '-b', 'main')
writeFileSync(join(main, 'README.md'), 'proof\n')
git(main, 'add', 'README.md')
git(main, 'commit', '-q', '-m', 'proof root')
git(main, 'worktree', 'add', '-q', '--detach', lane)

const readProjects = (home: string): Record<string, { hasTrustDialogAccepted?: boolean; hasCompletedProjectOnboarding?: boolean }> =>
  (JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as { projects: Record<string, never> }).projects

section('the derivation agrees with the product (findCanonicalGitRoot)')
{
  check('a linked worktree keys to the MAIN worktree root', canonicalProjectKeyOf(lane) === main, `${canonicalProjectKeyOf(lane)} vs ${main}`)
  check('…exactly as the product derives it', canonicalProjectKeyOf(lane) === findCanonicalGitRoot(lane), `${canonicalProjectKeyOf(lane)} vs ${findCanonicalGitRoot(lane)}`)
  check('the main checkout keys to itself', canonicalProjectKeyOf(main) === main && findCanonicalGitRoot(main) === main)
  check('a folder outside any repo has no second key', canonicalProjectKeyOf(plain) === null && findCanonicalGitRoot(plain) === null)
}

section('the seed writes every key the product will read')
{
  const homeLane = join(SCRATCH, 'home-lane')
  seedFirstRun(homeLane, [lane])
  const projects = readProjects(homeLane)
  check('a worktree cwd seeds its raw spelling', projects[lane] !== undefined, Object.keys(projects).join(', '))
  check('…AND the main root the product keys it to', projects[main] !== undefined, Object.keys(projects).join(', '))
  check(
    'both records are trusted and onboarding-complete',
    [lane, main].every(k => projects[k]?.hasTrustDialogAccepted === true && projects[k]?.hasCompletedProjectOnboarding === true),
  )
  check('exactly two records — the same folder is never keyed twice', Object.keys(projects).length === 2)

  const homeMain = join(SCRATCH, 'home-main')
  seedFirstRun(homeMain, [main])
  const mainProjects = readProjects(homeMain)
  check('the main checkout seeds ONE key (its own)', Object.keys(mainProjects).length === 1 && mainProjects[main] !== undefined, Object.keys(mainProjects).join(', '))

  const homePlain = join(SCRATCH, 'home-plain')
  seedFirstRun(homePlain, [plain])
  const plainProjects = readProjects(homePlain)
  check('a folder outside any repo seeds its raw spelling only', Object.keys(plainProjects).length === 1 && plainProjects[plain] !== undefined)
}

section('absent-only stands')
{
  const homeKept = join(SCRATCH, 'home-kept')
  mkdirSync(homeKept, { recursive: true })
  writeFileSync(join(homeKept, '.mercury.json'), '{"theme":"light","projects":{}}\n')
  seedFirstRun(homeKept, [lane])
  check('an existing config file is never rewritten', readFileSync(join(homeKept, '.mercury.json'), 'utf8') === '{"theme":"light","projects":{}}\n')
  check('the seeder created no home beside it', !existsSync(join(SCRATCH, 'unused-home', '.mercury.json')))
}

git(main, 'worktree', 'remove', '--force', lane)
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the seeded proof home reaches the slice the product reads' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
