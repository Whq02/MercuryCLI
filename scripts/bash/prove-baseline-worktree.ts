#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-baseline-worktree.ts
//  PROOF: (NEW-4) — the stash-free A/B baseline journey:
//    - a DETACHED worktree materializes at the requested revision under the
//      project temp dir, on a scratch LEASE;
//    - the LIVE tree is never mutated (a dirty file survives byte-identical
//      — the field tester's stash round-trips are exactly what this
//      replaces);
//    - dispose() removes exactly this worktree and releases the lease;
//    - a bogus revision refuses typed.
//  Hygiene: MERCURY_TMPDIR + MERCURY_CONFIG_DIR scratch-pinned.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_SCRATCH = mkdtempSync(join(tmpdir(), 'ab-tmp-'))
process.env.MERCURY_TMPDIR = TMP_SCRATCH
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ab-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { createBaselineWorktree } = await import(join(ROOT, 'src/utils/worktree.ts'))
const { listScratchLeftovers } = await import(join(ROOT, 'src/utils/scratchLeases.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Baseline worktree A/B journey — proof')
console.log('============================================================')

const repo = mkdtempSync(join(tmpdir(), 'ab-repo-'))
function sh(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@l', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@l' },
  })
}

try {
  sh(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(repo, 'app.ts'), 'export const v = 1\n')
  sh(['add', '.'])
  sh(['commit', '--quiet', '-m', 'v1'])
  const v1 = sh(['rev-parse', 'HEAD']).trim()
  writeFileSync(join(repo, 'app.ts'), 'export const v = 2\n')
  sh(['commit', '--quiet', '-am', 'v2'])

  // Uncommitted live-tree work — the thing stashing would otherwise endanger.
  writeFileSync(join(repo, 'app.ts'), 'export const v = 3 // WIP\n')
  const dirtyBefore = readFileSync(join(repo, 'app.ts'), 'utf8')

  const baseline = await createBaselineWorktree(v1, repo)
  check('baseline created OK', baseline.ok === true, JSON.stringify(baseline).slice(0, 100))
  if (baseline.ok) {
    check('baseline is DETACHED at the requested revision', execFileSync('git', ['-C', baseline.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === v1)
    check('baseline carries the v1 content (the A side)', readFileSync(join(baseline.path, 'app.ts'), 'utf8') === 'export const v = 1\n')
    check('the LIVE tree is untouched — dirty WIP survives byte-identical (no stash)', readFileSync(join(repo, 'app.ts'), 'utf8') === dirtyBefore)
    check('the baseline is LEASED (inventoried leftover)', listScratchLeftovers().some(l => l.root === baseline.path && /baseline worktree/.test(l.recovery)))
    await baseline.dispose()
    check('dispose removes exactly this worktree', !existsSync(baseline.path))
    check('dispose releases the lease', !listScratchLeftovers().some(l => l.root === baseline.path))
    check('the live tree STILL untouched after dispose', readFileSync(join(repo, 'app.ts'), 'utf8') === dirtyBefore)
  }

  const bogus = await createBaselineWorktree('not-a-revision-anywhere', repo)
  check('a bogus revision refuses typed', bogus.ok === false && /not a commit/.test((bogus as { reason: string }).reason))
} finally {
  rmSync(repo, { recursive: true, force: true })
  rmSync(TMP_SCRATCH, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL BASELINE-WORKTREE PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
