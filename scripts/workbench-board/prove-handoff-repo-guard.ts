#!/usr/bin/env bun
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

function repoRootOf(p: string): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: p,
    encoding: 'utf8',
  }).trim()
  const abs = common.startsWith('/') ? common : join(p, common)
  return realpathSync(join(abs, '..'))
}

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
}
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
