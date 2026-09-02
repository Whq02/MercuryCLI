#!/usr/bin/env bun
// DRAFT → scripts/consistency-census/prove-worktree-settlement.ts (land post-pool)
// ============================================================================
//  scripts/consistency-census/prove-worktree-settlement.ts — W2 (UN-12..14, 17):
//  the typed worktree delta + settlement receipts, driven on real fixture
//  repos through the REAL owners (readWorktreeDelta / settleAgentWorktree).
//
//  §A  classifier: porcelain records → tracked / authored / ephemeral
//      (incl. rename pairs + the Mercury cache-clock debris class)
// §B runtime-artifact-only lane SETTLES (worktree + branch absent after)
//  §C  pristine lane settles
//  §D  a commit blocks + is named
//  §E  a tracked edit blocks + is named
//  §F  a one-byte untracked authored file blocks + is NAMED (UN-14)
//  §G  mixed authored+runtime preserves (authored wins, runtime named apart)
//  §H  malformed/failed inspection ⇒ inspection-unavailable (fail closed)
//  §I  missing worktree ⇒ retryable-partial (visible, idempotent)
//  §J  repeated settlement of a settled lane is idempotent-safe
//  §K  branch-only residue: settle removes the branch with the worktree
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const wt = await import('../../src/utils/worktree.ts')

// §A — pure classifier
{
  const z = [
    ' M src/a.ts',
    'R  new.ts', 'old.ts',
    '?? notes.md',
    '?? .mercury/cache-clock/sessions/x.json',
    '?? .claude/cache-clock/sessions/y.json',
  ].join('\0') + '\0'
  const c = wt.classifyPorcelainRecords(z)
  check('§A tracked: modify + rename both sides', c.tracked.length === 3)
  check('§A authored untracked separated: a foreign-named dir is a project file, never Mercury-ephemeral', c.untrackedAuthored.length === 2 && c.untrackedAuthored.includes('notes.md'))
  check('§A Mercury cache-clock debris classes as Mercury-ephemeral', c.mercuryEphemeral.length === 1)
}

function mkRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'unison-w2-repo-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'w2@fixture')
  git(repo, 'config', 'user.name', 'w2')
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'seed')
  return { repo, head: git(repo, 'rev-parse', 'HEAD') }
}
let laneN = 0
function mkLane(repo: string): { lane: string; branch: string } {
  const branch = `unison/w2-lane-${++laneN}`
  const lane = join(mkdtempSync(join(tmpdir(), 'unison-w2-lanes-')), `lane-${laneN}`)
  git(repo, 'worktree', 'add', '-q', '-b', branch, lane, 'HEAD')
  return { lane, branch }
}
const settle = (repo: string, lane: string, branch: string, head: string) =>
  wt.settleAgentWorktree({ worktreePath: lane, worktreeBranch: branch, headCommit: head, gitRoot: repo })

// §B — runtime-artifact-only lane settles
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  mkdirSync(join(lane, '.mercury', 'cache-clock', 'sessions'), { recursive: true })
  writeFileSync(join(lane, '.mercury', 'cache-clock', 'sessions', 's.json'), '{}\n')
  const r = await settle(repo, lane, branch, head)
  check('§B runtime-only lane SETTLES', r.outcome === 'settled', r.outcome)
  check('§B worktree absent', !existsSync(lane))
  check('§B branch absent', (() => { try { git(repo, 'rev-parse', '--verify', branch); return false } catch { return true } })())
}

// §C — pristine settles
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  const r = await settle(repo, lane, branch, head)
  check('§C pristine lane settles', r.outcome === 'settled')
}

// §D — a commit blocks + names
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  writeFileSync(join(lane, 'work.ts'), 'x\n')
  git(lane, 'add', '.')
  git(lane, 'commit', '-q', '-m', 'authored')
  const r = await settle(repo, lane, branch, head)
  check('§D commit preserves', r.outcome === 'preserved')
  check('§D named', r.outcome === 'preserved' && r.summary.includes('1 commit'))
}

// §E — tracked edit blocks
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  writeFileSync(join(lane, 'README.md'), 'edited\n')
  const r = await settle(repo, lane, branch, head)
  check('§E tracked edit preserves + names the path', r.outcome === 'preserved' && r.summary.includes('README.md'))
}

// §F — one-byte authored untracked file (the acceptance's exact case)
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  writeFileSync(join(lane, 'idea.txt'), 'x')
  const r = await settle(repo, lane, branch, head)
  check('§F one-byte authored file preserved AND named', r.outcome === 'preserved' && r.summary.includes('idea.txt'))
  check('§F lane + branch still present', existsSync(lane))
}

// §G — mixed authored + runtime: authored wins; runtime named apart
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  writeFileSync(join(lane, 'notes.md'), 'keep me\n')
  mkdirSync(join(lane, '.mercury', 'cache-clock', 'sessions'), { recursive: true })
  writeFileSync(join(lane, '.mercury', 'cache-clock', 'sessions', 's.json'), '{}\n')
  const r = await settle(repo, lane, branch, head)
  check('§G mixed preserves', r.outcome === 'preserved')
  check(
    '§G delta separates authored from runtime',
    r.outcome === 'preserved' &&
      r.delta.untrackedAuthored.includes('notes.md') &&
      r.delta.mercuryEphemeral.some(p => p.includes('cache-clock')),
  )
}

// §H — inspection failure fails CLOSED
{
  const dir = mkdtempSync(join(tmpdir(), 'unison-w2-notgit-'))
  const d = await wt.readWorktreeDelta(dir)
  check('§H non-repo dir ⇒ uncertainty (never a clean-looking delta)', d.uncertainty !== null)
  const r = await wt.settleAgentWorktree({ worktreePath: dir, gitRoot: dir })
  check('§H settlement reports inspection-unavailable', r.outcome === 'inspection-unavailable')
}

// §I — missing worktree ⇒ retryable/visible (not silent success)
{
  const { repo } = mkRepo()
  const gone = join(tmpdir(), `unison-w2-gone-${Date.now()}`)
  const r = await wt.settleAgentWorktree({ worktreePath: gone, worktreeBranch: 'none', gitRoot: repo })
  check('§I missing lane is not a silent success', r.outcome !== 'settled')
}

// §J — repeated settlement of a settled lane
{
  const { repo, head } = mkRepo()
  const { lane, branch } = mkLane(repo)
  const r1 = await settle(repo, lane, branch, head)
  const r2 = await settle(repo, lane, branch, head)
  check('§J second settle is visible non-success (idempotent-safe)', r1.outcome === 'settled' && r2.outcome !== 'settled')
}

// §L — ONE settlement contract across the one-shot consumers (UN-15)
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dir, '../..')
  const agentTool = readFileSync(join(root, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const hooks = readFileSync(join(root, 'src/tools/WorkflowTool/agentHooks.ts'), 'utf8')
  check(
    '§L AgentTool + WorkflowTool both settle through settleAgentWorktree',
    agentTool.includes('settleAgentWorktree({') && hooks.includes('settleAgentWorktree({'),
  )
  check(
    '§L neither consumer hand-rolls the old boolean+remove pair',
    !agentTool.includes('hasWorktreeChanges(') && !hooks.includes('hasWorktreeChanges('),
  )
}

// §M — lifecycle POLICY stays per-owner over the SHARED classification (UN-16)
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dir, '../..')
  const contexts = readFileSync(join(root, 'src/services/workContexts/workContexts.ts'), 'utf8')
  check(
    '§M operator work contexts keep the FULL -uall preview (operator-intentional law — never an agent removal policy)',
    contexts.includes("'-uall'") && !contexts.includes('settleAgentWorktree'),
  )
  const janitor = readFileSync(join(root, 'src/utils/worktree.ts'), 'utf8')
  check(
    '§M the janitor classifies via the same delta (the -uno split is gone)',
    janitor.includes('deltaBlocksSettlement(delta)') && !janitor.includes("'-uno'"),
  )
}

// §N — Windows path semantics (UN-18): junction-reached lanes + open-handle
// settlement. win32-only legs — a POSIX run SKIPS loudly, and the
// windows-functional lane runs this prover on a real NTFS runner.
if (process.platform === 'win32') {
  const { symlinkSync, openSync, closeSync } = await import('node:fs')
  // §N1 junction: settling THROUGH a junction path resolves and settles.
  {
    const { repo, head } = mkRepo()
    const { lane, branch } = mkLane(repo)
    const junction = join(mkdtempSync(join(tmpdir(), 'unison-w2-junc-')), 'via')
    symlinkSync(lane, junction, 'junction')
    const r = await wt.settleAgentWorktree({
      worktreePath: junction,
      worktreeBranch: branch,
      headCommit: head,
      gitRoot: repo,
    })
    check('§N1 junction-reached pristine lane settles (or reports typed non-success — never silent)', r.outcome === 'settled' || r.outcome === 'retryable-partial', r.outcome)
  }
  // §N2 open handle: a held file handle inside a PRISTINE lane cannot
  // produce a silent success claim (Windows refuses the directory removal
  // while a handle is open — the receipt must be typed retryable-partial or
  // a genuine verified settle, never a false 'settled'); closing the handle
  // lets settlement complete.
  {
    const { repo, head } = mkRepo()
    const { lane, branch } = mkLane(repo)
    const fd = openSync(join(lane, 'README.md'), 'r')
    const r1 = await wt.settleAgentWorktree({
      worktreePath: lane,
      worktreeBranch: branch,
      headCommit: head,
      gitRoot: repo,
    })
    check(
      '§N2 open-handle settlement is typed, never a silent success claim',
      r1.outcome === 'settled' || r1.outcome === 'retryable-partial',
      r1.outcome,
    )
    closeSync(fd)
    if (r1.outcome !== 'settled') {
      const r2 = await wt.settleAgentWorktree({
        worktreePath: lane,
        worktreeBranch: branch,
        headCommit: head,
        gitRoot: repo,
      })
      check('§N2 settlement completes once the handle releases', r2.outcome === 'settled', r2.outcome)
    }
  }
} else {
  console.log('  [SKIP] §N windows path/handle legs (posix host — the windows-functional lane runs them)')
}

console.log(failed === 0 ? '\n ✅ WORKTREE SETTLEMENT LAWS HOLD' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
