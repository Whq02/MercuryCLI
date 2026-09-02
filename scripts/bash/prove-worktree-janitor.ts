#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-worktree-janitor.ts
//  PROOF: the worktree janitor — the stale-sweep
//  actually reaps what leaks and never touches what matters:
//    - registered ephemeral worktrees (agent-*/parcel-*) that are stale,
//      clean, and pushed are REMOVED with their lane branches;
//    - dirty or unpushed lanes are KEPT (fail-closed), fresh lanes are KEPT
//      (the 7-day retention floor clamps a 30-day cutoff), user-named
//      worktrees are KEPT (pattern allowlist);
//    - ORPHAN dirs (no registration + failed .git round-trip) and DISOWNED
//      copies (back-pointer names a different path) are reaped directly —
//      the class the old sweep left in place forever;
//    - crashed-adoption debris (`worktrees.adopting-<pid>`) is reaped;
//    - the canonical worktrees dir is NON-adoptive: legacy `.claude/
//      worktrees` content is neither copied forward nor deleted.
//  Hygiene: config home + tmp scratch-pinned; everything in mkdtemp.
// ============================================================================

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_TMPDIR = mkdtempSync(join(tmpdir(), 'wj-tmp-'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wj-home-'))

const ROOT = join(import.meta.dir, '..', '..')
const { cleanupStaleAgentWorktrees } = await import(
  join(ROOT, 'src/utils/worktree.ts')
)
const { runWithCwdOverride } = await import(join(ROOT, 'src/utils/cwd.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Worktree janitor — stale-sweep proof')
console.log('============================================================')

// realpath: macOS mkdtemp lives under the /var → /private/var symlink, and
// the sweep compares git-recorded (real) paths against constructed ones.
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'wj-repo-')))
const remote = realpathSync(mkdtempSync(join(tmpdir(), 'wj-remote-')))
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'p',
  GIT_AUTHOR_EMAIL: 'p@l',
  GIT_COMMITTER_NAME: 'p',
  GIT_COMMITTER_EMAIL: 'p@l',
}
function git(args: string[], cwd: string = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
}

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
async function age(path: string): Promise<void> {
  await utimes(path, TEN_DAYS_AGO, TEN_DAYS_AGO)
}

const wtHome = join(repo, '.mercury', 'worktrees')
function addWorktree(slug: string): string {
  const path = join(wtHome, slug)
  git(['worktree', 'add', '--quiet', '-b', `worktree-${slug}`, path])
  return path
}

try {
  git(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(repo, 'app.ts'), 'export const v = 1\n')
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'v1'])
  git(['init', '--quiet', '--bare'], remote)
  git(['remote', 'add', 'origin', remote])
  git(['push', '--quiet', 'origin', 'main'])
  mkdirSync(wtHome, { recursive: true })

  // A: stale + clean + pushed agent lane (current 16-hex slug shape) → swept.
  const a = addWorktree('agent-a3cb25bd1c6ce6f74')
  await age(a)
  // B: stale but DIRTY parcel lane → kept.
  const b = addWorktree('parcel-b1b2b3b4b5b6')
  writeFileSync(join(b, 'app.ts'), 'export const v = 99 // WIP\n')
  await age(b)
  // C: stale, clean, but UNPUSHED (historical 7-hex agent shape) → kept.
  const c = addWorktree('agent-a0123abc')
  writeFileSync(join(c, 'new.ts'), 'export const n = 1\n')
  git(['add', '.'], c)
  git(['commit', '--quiet', '-m', 'unpushed'], c)
  await age(c)
  // D: FRESH clean parcel lane → kept (the 7-day floor clamps a 30d cutoff).
  addWorktree('parcel-d1d2d3d4d5d6')
  // E: orphan junk dir, never registered → reaped.
  const e = join(wtHome, 'parcel-e1e2e3e4e5e6')
  mkdirSync(e, { recursive: true })
  writeFileSync(join(e, 'junk.txt'), 'x\n')
  await age(e)
  // F: DISOWNED copy of a live worktree (back-pointer names the original) → reaped.
  const w = addWorktree('parcel-f0f0f0f0f0f0') // stays fresh, kept
  const f = join(wtHome, 'parcel-c0c0c0c0c0c0')
  cpSync(w, f, { recursive: true })
  await age(f)
  // G: user-named worktree, stale + clean + pushed → kept (pattern allowlist).
  const g = join(wtHome, 'keepme')
  git(['worktree', 'add', '--quiet', '-b', 'worktree-keepme', g])
  await age(g)
  // H: crashed-adoption debris beside the canonical dir → reaped.
  const h = join(repo, '.mercury', 'worktrees.adopting-4999999')
  mkdirSync(join(h, 'parcel-old'), { recursive: true })
  writeFileSync(join(h, 'parcel-old', 'junk.txt'), 'x\n')
  await age(h)
  // I: legacy-home content — unregistered junk under `.claude/worktrees`:
  // neither adopted forward nor deleted.
  const legacy = join(repo, '.claude', 'worktrees', 'parcel-abcdefabcdef')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'junk.txt'), 'x\n')
  await age(join(repo, '.claude', 'worktrees', 'parcel-abcdefabcdef'))

  // The sweep anchors on the session cwd — override it onto the scratch repo
  // for this async context only (the seam concurrent agents use).
  const removed: number = await runWithCwdOverride(repo, () =>
    cleanupStaleAgentWorktrees(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  )

  const branches = git(['branch', '--format=%(refname:short)'])
  check('A stale+clean+pushed agent lane swept', !existsSync(a))
  check('A lane branch deleted', !branches.includes('worktree-agent-a3cb25bd1c6ce6f74'))
  check('B dirty lane kept', existsSync(join(b, 'app.ts')))
  check('C unpushed lane kept', existsSync(join(c, 'new.ts')))
  check('D fresh lane kept (7-day floor clamps the 30d cutoff)', existsSync(join(wtHome, 'parcel-d1d2d3d4d5d6')))
  check('E orphan dir reaped', !existsSync(e))
  check('F disowned copy reaped', !existsSync(f))
  check('F original live lane kept', existsSync(w))
  check('G user-named worktree kept', existsSync(g))
  check('H adoption debris reaped', !existsSync(h))
  check('I legacy .claude content untouched', existsSync(join(legacy, 'junk.txt')))
  check('I nothing adopted into the canonical home', !existsSync(join(wtHome, 'parcel-abcdefabcdef')))
  check('sweep count == 4 (A + E + F-copy + H)', removed === 4, `removed=${removed}`)
} catch (err) {
  failures++
  console.log(`  [FAIL] prover crashed — ${err}`)
}

console.log(failures === 0 ? '✅ worktree janitor proof PASS' : `❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
