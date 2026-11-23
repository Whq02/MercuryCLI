#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ' — change: the cold-read path of getCachedBranch and getCachedHead in src/platform/git/gitFilesystem.ts, or getGitState in src/platform/git/git.ts, so that every concurrent first read answers the real value'}`)
}

const repo = mkdtempSync(join(tmpdir(), 'git-cache-coldread-'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'git-cache-coldread-home-'))
const git = (...args: string[]): void => {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}
git('init', '-q', '-b', 'main', '.')
writeFileSync(join(repo, 'README.md'), 'cold-read proof\n')
git('add', '-A')
git('-c', 'user.email=hx@example.com', '-c', 'user.name=hx', 'commit', '-qm', 'init')
process.chdir(repo)

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' the git cache cold-read answers truth to EVERY racer')
  console.log('============================================================')

  const fsMod = await import('../../src/platform/git/gitFilesystem.js')
  const gitMod = await import('../../src/platform/git/git.js')

  console.log('\n§1 concurrent FIRST reads of one key all answer the branch')
  {
    const branches = await Promise.all(
      Array.from({ length: 6 }, () => fsMod.getCachedBranch()),
    )
    check(
      'every racer answers main (no placeholder leaks)',
      branches.every(b => b === 'main'),
      JSON.stringify(branches),
    )
    const heads = await Promise.all(Array.from({ length: 6 }, () => fsMod.getCachedHead()))
    check(
      'every head racer answers the same non-empty sha',
      heads.every(h => typeof h === 'string' && h.length === 40 && h === heads[0]),
      JSON.stringify(heads.map(h => (typeof h === 'string' ? h.slice(0, 8) : String(h)))),
    )
  }

  console.log('\n§2 the user-visible law — concurrent getGitState never no-gits a real repo')
  {
    const states = await Promise.all(Array.from({ length: 4 }, () => gitMod.getGitState()))
    check(
      'every concurrent getGitState answers live state (never null on a real repo)',
      states.every(s => s !== null && s.branchName === 'main' && s.commitHash.length === 40),
      JSON.stringify(states.map(s => (s === null ? 'null' : s.branchName))),
    )
  }


  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ THE GIT CACHE COLD-READ ANSWERS TRUTH TO EVERY RACER')
  process.exit(0)
}

void main()
