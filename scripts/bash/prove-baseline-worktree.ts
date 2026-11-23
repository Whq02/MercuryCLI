#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_SCRATCH = mkdtempSync(join(tmpdir(), 'ab-tmp-'))
process.env.MERCURY_TMPDIR = TMP_SCRATCH
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ab-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { createBaselineWorktree } = await import(join(ROOT, 'src/platform/git/worktree/worktree.ts'))
const { listScratchLeftovers } = await import(join(ROOT, 'src/platform/files/scratchLeases.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
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
  sh(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'app.ts'), 'export const v = 1\n')
  sh(['add', '.'])
  sh(['commit', '--quiet', '-m', 'v1'])
  const v1 = sh(['rev-parse', 'HEAD']).trim()
  writeFileSync(join(repo, 'app.ts'), 'export const v = 2\n')
  sh(['commit', '--quiet', '-am', 'v2'])

  writeFileSync(join(repo, 'app.ts'), 'export const v = 3 // WIP\n')
  const dirtyBefore = readFileSync(join(repo, 'app.ts'), 'utf8')

  const baseline = await createBaselineWorktree(v1, repo)
  check('baseline created OK', baseline.ok === true, JSON.stringify(baseline).slice(0, 100), 'createBaselineWorktree in src/platform/git/worktree/worktree.ts must return ok: true for a valid commit; read the reason in the JSON above')
  if (baseline.ok) {
    check('baseline is DETACHED at the requested revision', execFileSync('git', ['-C', baseline.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === v1, '', 'createBaselineWorktree in src/platform/git/worktree/worktree.ts must check the worktree out detached at the revision it was given')
    check('baseline carries the v1 content (the A side)', readFileSync(join(baseline.path, 'app.ts'), 'utf8') === 'export const v = 1\n', '', 'createBaselineWorktree in src/platform/git/worktree/worktree.ts must check out the requested revision content into baseline.path')
    check('the LIVE tree is untouched — dirty WIP survives byte-identical (no stash)', readFileSync(join(repo, 'app.ts'), 'utf8') === dirtyBefore, '', 'createBaselineWorktree in src/platform/git/worktree/worktree.ts must not stash, reset or write in the live repo')
    check('the baseline is LEASED (inventoried leftover)', listScratchLeftovers().some(l => l.root === baseline.path && /baseline worktree/.test(l.recovery)), '', 'createBaselineWorktree in src/platform/git/worktree/worktree.ts must register a scratch lease whose recovery text says baseline worktree (registerScratchLease in src/platform/files/scratchLeases.ts)')
    await baseline.dispose()
    check('dispose removes exactly this worktree', !existsSync(baseline.path), '', 'the dispose function returned by createBaselineWorktree in src/platform/git/worktree/worktree.ts must remove the worktree directory')
    check('dispose releases the lease', !listScratchLeftovers().some(l => l.root === baseline.path), '', 'the dispose function in createBaselineWorktree (src/platform/git/worktree/worktree.ts) must call releaseScratchLease')
    check('the live tree STILL untouched after dispose', readFileSync(join(repo, 'app.ts'), 'utf8') === dirtyBefore, '', 'the dispose function in createBaselineWorktree (src/platform/git/worktree/worktree.ts) must not touch the live repo')
  }

  const bogus = await createBaselineWorktree('not-a-revision-anywhere', repo)
  check('a bogus revision refuses typed', bogus.ok === false && /not a commit/.test((bogus as { reason: string }).reason), '', 'createBaselineWorktree in src/platform/git/worktree/worktree.ts must return ok: false with a reason saying the revision is not a commit')
} finally {
  rmSync(repo, { recursive: true, force: true })
  rmSync(TMP_SCRATCH, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL BASELINE-WORKTREE PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
