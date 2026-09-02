#!/usr/bin/env bun
// ============================================================================
//  scripts/workbench-board/prove-handoff-repo-guard.ts — executeHandoff's
//  wrong-repo provisioning guard must anchor on the SAME root the provisioner
//  uses.
//
//  The defect: the guard compared `process.cwd()`'s repo root against the
//  context's repo — but createAgentWorktree anchors on getCwd() (the session
//  cwd: updated by a Bash `cd` via setCwd, overridden per-async-context for
//  subagents via runWithCwdOverride; NEITHER moves process.cwd()). With the
//  two diverged (a `cd` to another repo, or any cwd-overridden agent
//  context), the guard passed on the wrong evidence and the handoff
//  provisioned a worktree off a DIFFERENT repo than its context — the exact
//  wrong-project hole the guard was added to close (verify wave, ACP
//  finding 4).
//
//  Legs (falsifiable both directions):
//    · diverged (getCwd → repo B, process.cwd → repo A, context → repo A):
//      the handoff MUST refuse — a lane off repo B would be wrong-project;
//    · aligned (getCwd → repo A): the handoff MUST provision, and the lane's
//      own repo root must be repo A (no false refusal).
//
//  Run:  ~/.bun/bin/bun run scripts/workbench-board/prove-handoff-repo-guard.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('── handoff provisioning guard anchors on getCwd ──')

const base = mkdtempSync(join(tmpdir(), 'lantern-handoff-'))
process.env.MERCURY_WORK_CONTEXTS_DIR = join(base, 'contexts')
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = join(base, 'artifacts')

function mkRepo(name: string): string {
  const dir = join(base, name)
  const git = (args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'lantern',
        GIT_AUTHOR_EMAIL: 'l@local',
        GIT_COMMITTER_NAME: 'lantern',
        GIT_COMMITTER_EMAIL: 'l@local',
      },
    })
  }
  execFileSync('mkdir', ['-p', dir])
  git(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(dir, 'seed.txt'), `${name}\n`)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'seed'])
  return realpathSync(dir)
}

const repoA = mkRepo('repo-a')
const repoB = mkRepo('repo-b')

const { bindWorkContext, previewHandoff, executeHandoff } = await import(
  '../../src/services/workContexts/workContexts.ts'
)
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

/** The OWNING repo of a checkout — worktree-aware: --git-common-dir resolves
 *  to the main repo's .git for linked worktrees. */
function repoRootOf(p: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: p,
    encoding: 'utf8',
  }).trim()
  const abs = common.startsWith('/') ? common : join(p, common)
  return realpathSync(join(abs, '..'))
}

// The context belongs to repo A; the prover process sits in repo A (the old
// guard's evidence), while the SESSION cwd (getCwd) points at repo B.
process.chdir(repoA)

{
  const ctx = bindWorkContext({ sessionId: 'lantern', mode: 'local', root: repoA })
  const preview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree' } })
  check('preview computes', preview.ok, preview.ok ? '' : preview.reason)
  if (preview.ok) {
    const result = await runWithCwdOverride(repoB, () =>
      executeHandoff({
        contextId: ctx.contextId,
        to: { mode: 'worktree', newWorktreeSlug: 'lantern_diverged' },
        preview: preview.value,
      }),
    )
    if (result.ok) {
      const laneRoot = result.value.context.worktreePath
        ? repoRootOf(result.value.context.worktreePath)
        : '(none)'
      check(
        'diverged cwd: the handoff must refuse (wrong-project lane)',
        false,
        `provisioned ${result.value.context.worktreePath} — lane repo root ${laneRoot} (context repo ${repoA})`,
      )
    } else {
      check('diverged cwd: the handoff refuses with the named reason', /repo/.test(result.reason), result.reason)
    }
  }
}

// No false refusal: aligned cwd provisions a lane on the context's own repo.
{
  const ctx = bindWorkContext({ sessionId: 'lantern', mode: 'local', root: repoA })
  const preview = await previewHandoff({ contextId: ctx.contextId, to: { mode: 'worktree' } })
  check('aligned preview computes', preview.ok, preview.ok ? '' : preview.reason)
  if (preview.ok) {
    const result = await runWithCwdOverride(repoA, () =>
      executeHandoff({
        contextId: ctx.contextId,
        to: { mode: 'worktree', newWorktreeSlug: 'lantern_aligned' },
        preview: preview.value,
      }),
    )
    check('aligned cwd: the handoff provisions', result.ok, result.ok ? '' : result.reason)
    if (result.ok) {
      const laneRoot = result.value.context.worktreePath
        ? repoRootOf(result.value.context.worktreePath)
        : '(none)'
      check('the lane lives on the context repo', laneRoot === repoA, `lane root ${laneRoot}`)
    }
  }
}

try {
  rmSync(base, { recursive: true, force: true })
} catch {
  /* best-effort */
}
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
