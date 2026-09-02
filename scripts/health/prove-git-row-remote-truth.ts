#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-git-row-remote-truth.ts — the certificate's git row
//  never says 'ahead of remote' about a repository that has no remote
//  (FC-126). isHeadOnRemote answers "does an upstream EXIST", not "is HEAD
//  on it", so a plain git init checkout — and every branch without an
//  upstream — wore a sentence about a remote the row itself proves is not
//  there. Ahead-ness is unpushedCount's fact; the other states are now
//  named as what they are: 'no remote configured' and 'no upstream for
//  this branch'.
//
//  Four grounds, per the card: remoteless with a commit; a real clone
//  (in sync); the clone one commit ahead; a remote configured without an
//  upstream.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-git-row-remote-truth.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'gitrow-home-')))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'gitrow-')))
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=proof', ...args], { cwd, stdio: 'ignore' })
}

const origin = join(BASE, 'origin')
mkdirSync(origin, { recursive: true })
git(origin, 'init', '-q', '-b', 'main')
writeFileSync(join(origin, 'a.txt'), 'a\n')
git(origin, 'add', 'a.txt')
git(origin, 'commit', '-q', '-m', 'first')

const { setCwd } = await import('../../src/utils/Shell.js')
const { regroundGitWatch } = await import('../../src/utils/git/gitFilesystem.js')
const report = await import('../../src/utils/healthReport.js')
const gitRow = async (dir: string): Promise<string> => {
  setCwd(dir)
  process.chdir(dir)
  // The git probes ride process-lifetime caches pinned to the boot cwd;
  // regrounding is the documented reset for a moved working directory.
  regroundGitWatch()
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'git')
  return String(row?.evidence ?? '(no git row)')
}

console.log('§1 remoteless repo with a commit')
{
  const ev = await gitRow(origin)
  check(
    "says 'no remote configured', never 'ahead of remote'",
    ev.includes('no remote configured') && !ev.includes('ahead of remote'),
    ev,
  )
}

console.log('\n§2 a real clone, in sync')
{
  const clone = join(BASE, 'clone')
  git(BASE, 'clone', '-q', origin, clone)
  const ev = await gitRow(clone)
  check(
    'carries neither clause (upstream exists, nothing unpushed)',
    !ev.includes('no remote') && !ev.includes('ahead of remote') && !ev.includes('no upstream') && !ev.includes('unpushed'),
    ev,
  )

  console.log('\n§3 the clone one commit ahead')
  writeFileSync(join(clone, 'b.txt'), 'b\n')
  git(clone, 'add', 'b.txt')
  git(clone, 'commit', '-q', '-m', 'second')
  const ahead = await gitRow(clone)
  check("says '1 unpushed' (the count is the ahead-ness fact)", ahead.includes('1 unpushed'), ahead)
}

console.log('\n§4 a remote configured, branch without an upstream')
{
  const stray = join(BASE, 'stray')
  mkdirSync(stray, { recursive: true })
  git(stray, 'init', '-q', '-b', 'main')
  writeFileSync(join(stray, 'c.txt'), 'c\n')
  git(stray, 'add', 'c.txt')
  git(stray, 'commit', '-q', '-m', 'first')
  git(stray, 'remote', 'add', 'origin', origin)
  const ev = await gitRow(stray)
  check(
    "says 'no upstream for this branch', never 'ahead of remote'",
    ev.includes('no upstream for this branch') && !ev.includes('ahead of remote'),
    ev,
  )
}

console.log(failures === 0 ? '\nprove-git-row-remote-truth: all green' : `\nprove-git-row-remote-truth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
