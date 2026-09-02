#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-git-cache-coldread.ts
//  PROOF (lane HX): the watching git cache answers the TRUTH to every reader
//  of a key's FIRST compute — a racing cold-cache read must share the
//  in-flight compute, never the `undefined` placeholder.
//
//  The bug this pins (found live on the built product):
//  cachedRead cleared the dirty flag BEFORE the compute, so any reader
//  arriving while a key's first compute was in flight returned entry.value —
//  still the placeholder. Boot-time consumers race exactly like this
//  (the sessions strip, MercuryHome's git row, init's getGithubRepo primer),
//  so getGitState folded head=undefined branch=undefined into null and the
//  home card painted 'no git' for REAL repositories on every boot. The `as T`
//  cast silenced the type lie (the cast-masking class).
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-git-cache-coldread.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// The scratch repo + cwd + config home land BEFORE any src import so the
// module's process-cold first reads are the ones under proof.
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

  const fsMod = await import('../../src/utils/git/gitFilesystem.js')
  const gitMod = await import('../../src/utils/git.js')

  console.log('\n§1 concurrent FIRST reads of one key all answer the branch')
  {
    // Six racers on a process-cold cache: the first entrant computes, the
    // rest must share that compute (the broken shape answered `undefined`).
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

  console.log('\n§3 the source pin — cachedRead shares its in-flight first compute')
  {
    const src = readFileSync(
      join(import.meta.dir, '..', '..', 'src', 'utils', 'git', 'gitFilesystem.ts'),
      'utf-8',
    )
    check('the entry carries the in-flight compute', src.includes('inflight: Promise<unknown> | null'))
    check(
      'a clean entry with a compute in flight is AWAITED, not read as the placeholder',
      /if \(entry\.inflight !== null\) return \(await entry\.inflight\) as T/.test(src),
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
