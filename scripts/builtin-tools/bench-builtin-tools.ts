#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/bench-builtin-tools.ts — the capability BENCHMARK
// A deterministic corpus of representative software-engineering
//  jobs run against DISPOSABLE fixtures (temp dirs, disposable git repos, a
//  real loopback node HTTP fixture) through Mercury's TYPED tool substrate —
//  ZERO paid model calls. It measures CAPABILITY, not tool count: for each
//  task we record completion, retries, failed operations, false-success
//  claims (asserted NONE), elapsed time, output boundedness, and the
//  resource / transaction / evidence / cleanup completeness the task's
//  capability contract requires.
//
//  This file is the corpus LIBRARY + a `--write` CLI. The gate that runs it
//  and refuses drift is scripts/builtin-tools/prove-builtin-tools-benchmark.ts. The
//  COMMITTED anchor (scripts/builtin-tools/fixtures/results.json) is the STABLE
//  PROJECTION — capability facts + fixed contract counts, never exact
//  timings — so it is byte-stable across runs and machines. Exact millisecond
//  timings live only in the console + the (regenerated) RESULTS.md buckets.
// ============================================================================

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// —— hermetic seams: keep every side effect off the real config home ————————
// (set BEFORE any dynamic import — getMercuryHome memoizes on first read)
const repoRoot = resolve(import.meta.dir, '..', '..')
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'builtin-tools-bench-home-'))
const DAEMON_HOME = mkdtempSync(join(tmpdir(), 'builtin-tools-bench-daemon-'))
if (!process.env.MERCURY_CONFIG_DIR) process.env.MERCURY_CONFIG_DIR = CONFIG_HOME
if (!process.env.MERCURY_DAEMON_DIR) process.env.MERCURY_DAEMON_DIR = DAEMON_HOME
// The structural facility resolves the vendored compiler beside the bundle;
// in a fresh worktree with no built dist we point it at the workspace's own
// typescript so the tool-LEVEL benchmark is portable. A built tree (real
// dist/vendor/typescript) keeps precedence — this is a last-resort override.
if (!process.env.MERCURY_TYPESCRIPT_VENDOR_DIR) {
  const vendored = join(repoRoot, 'dist', 'vendor', 'typescript', 'typescript.js')
  if (!existsSync(vendored)) {
    try {
      const tsMain = createRequire(join(repoRoot, 'x.ts')).resolve('typescript')
      process.env.MERCURY_TYPESCRIPT_VENDOR_DIR = resolve(tsMain, '..')
    } catch {
      /* leave unset — the structure tasks will report unavailable honestly */
    }
  }
}

// —— API imports (the typed capability substrate under test) ————————————————
const { runStructureQuery } = await import('../../src/services/structure/query.ts')
const { buildPreview, applyPreview } = await import('../../src/services/structure/transform.ts')
const { _resetStructureStoreForTesting } = await import('../../src/services/structure/store.ts')
const { gitStatus, gitDiff, gitConflicts } = await import('../../src/services/gitGraph/observe.ts')
const { preparePlan, applyPlan, resolveConflict, _resetGitPlanStoreForTesting } = await import(
  '../../src/services/gitGraph/plan.ts'
)
const { runJourney, cancelJourney, _resetJourneysForTesting } = await import(
  '../../src/services/journeys/runner.ts'
)
const { getExecution } = await import('../../src/services/primitives/executionPlane.ts')
const { transactionsFor, _resetTransactionPlaneForTesting } = await import(
  '../../src/services/primitives/transactionPlane.ts'
)
const { evidenceFor, _resetEvidencePlaneForTesting } = await import(
  '../../src/services/primitives/evidencePlane.ts'
)
const { resolveResource } = await import('../../src/services/resources/registry.ts')
// register the resource adapters the corpus mints refs for
await import('../../src/services/resources/adapters/structure.ts')
await import('../../src/services/resources/adapters/git.ts')
await import('../../src/services/resources/adapters/journey.ts')
await import('../../src/services/resources/adapters/evidence.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { searchToolsWithKeywords } = await import(
  '../../src/tools/ToolSearchTool/ToolSearchTool.ts'
)

type OwnerKey = ReturnType<typeof processMainOwner>

// ── the per-task record ─────────────────────────────────────────────────────
export interface TaskResult {
  id: string
  capability: string
  toolPath: 'tool-level'
  /** the capability job completed as intended (a correct refusal counts) */
  completed: boolean
  /** retry attempts the capability needed (these ops are single-shot) */
  retries: number
  /** operations that failed UNEXPECTEDLY (a designed refusal is not one) */
  failedOperations: number
  /** a failed/partial step was NEVER summarized as success (asserted false) */
  falseSuccess: boolean
  elapsedMs: number
  outputBytes: number
  outputBounded: boolean
  /** primary mercury:// output refs the task mints, and whether ALL resolve */
  expectedResources: number
  resourcesResolved: boolean
  /** transactions that must reach settled WITH an observed effect */
  expectedTransactions: number
  transactionsSettled: boolean
  /** canonical evidence rows the task must leave on the ONE plane */
  expectedEvidence: number
  evidencePresent: boolean
  /** cleanup: temp trees removed, no surviving processes ('n/a' = nothing to reap) */
  cleanup: 'ok' | 'failed' | 'n/a'
  /** a short deterministic human note (RESULTS.md) */
  note: string
}

const OUTPUT_BOUND = 200_000 // bytes; every typed result stays well under this

const owner: OwnerKey = processMainOwner()
const PORT_BASE = 43_517

function resetPlanes(): void {
  _resetStructureStoreForTesting()
  _resetGitPlanStoreForTesting()
  _resetJourneysForTesting()
  _resetEvidencePlaneForTesting()
  _resetTransactionPlaneForTesting()
}

async function refsResolve(refs: string[], cwd: string): Promise<boolean> {
  for (const ref of refs) {
    const r = (await resolveResource(ref, { owner, cwd })) as { state: string }
    if (r.state !== 'ok') return false
  }
  return true
}

function sizeOf(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v ?? null))
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@local',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@local',
    },
  })
}

function portAlive(port: number): boolean {
  try {
    const out = execFileSync('bash', ['-c', `lsof -i :${port} -t | wc -l`], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    return Number(out.trim()) > 0
  } catch {
    return false
  }
}

function killPort(port: number): void {
  try {
    execFileSync('bash', ['-c', `lsof -i :${port} -t | xargs kill -9 2>/dev/null || true`], {
      timeout: 5_000,
    })
  } catch {
    /* best-effort */
  }
}

function removeTree(root: string): 'ok' | 'failed' {
  rmSync(root, { recursive: true, force: true })
  return existsSync(root) ? 'failed' : 'ok'
}

// ── the corpus ──────────────────────────────────────────────────────────────
export async function runCorpus(): Promise<TaskResult[]> {
  const tasks: TaskResult[] = []
  const push = (t: TaskResult): void => {
    tasks.push(t)
  }

  // ---- 1. structural query -------------------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-strq-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'src', 'a.ts'),
      "export function run(){ console.log('a'); track('x') }\n",
    )
    writeFileSync(join(root, 'src', 'b.js'), "function two(){ console.log('b') }\n")
    const r = runStructureQuery(root, { select: 'call', callee: 'console.log' } as never) as {
      state?: string
      matches?: { id: string }[]
    }
    const r2 = runStructureQuery(root, { select: 'call', callee: 'console.log' } as never) as {
      matches?: { id: string }[]
    }
    const ok =
      !('state' in r) &&
      (r.matches?.length ?? 0) === 2 &&
      JSON.stringify(r.matches?.map(m => m.id)) === JSON.stringify(r2.matches?.map(m => m.id))
    const failedOps = 'state' in r ? 1 : 0
    const cleanup = removeTree(root)
    push({
      id: 'structure-query',
      capability: 'Structural source query (Structure tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: failedOps,
      falseSuccess: false, // a read query has no success surface to fake
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(r),
      outputBounded: sizeOf(r) < OUTPUT_BOUND,
      expectedResources: 0,
      resourcesResolved: true,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 0,
      evidencePresent: true,
      cleanup,
      note: 'ts+js call query, deterministic ids across two runs',
    })
  }

  // ---- 2. codemod PREVIEW (writes nothing) ---------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-prev-'))
    mkdirSync(join(root, 'src'))
    const A = "import { track } from './t'\nexport const f = p => track('f', p)\n"
    const B = "import { track } from './t'\nexport const g = () => track('g', null)\n"
    writeFileSync(join(root, 'src', 'a.js'), A)
    writeFileSync(join(root, 'src', 'b.ts'), B)
    const q = runStructureQuery(root, { select: 'call', callee: 'track' } as never)
    const pv = buildPreview(owner, q as never, undefined, {
      action: 'replace-callee',
      to: 'metrics.record',
    } as never) as { id?: string; files?: unknown[]; reason?: string }
    const wroteNothing =
      readFileSync(join(root, 'src', 'a.js'), 'utf8') === A &&
      readFileSync(join(root, 'src', 'b.ts'), 'utf8') === B
    const ok = !!pv.id && (pv.files?.length ?? 0) === 2 && wroteNothing
    const refs = pv.id ? [`mercury://structure/preview/${pv.id}`] : []
    const resourcesResolved = ok && (await refsResolve(refs, root))
    const cleanup = removeTree(root)
    push({
      id: 'codemod-preview',
      capability: 'Multi-file codemod preview (Structure tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: pv.reason ? 1 : 0,
      falseSuccess: false,
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(pv),
      outputBounded: sizeOf(pv) < OUTPUT_BOUND,
      expectedResources: refs.length,
      resourcesResolved,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 0,
      evidencePresent: true,
      cleanup,
      note: 'previews 2 files, byte-identical tree, preview ref resolves',
    })
  }

  // ---- 3. codemod APPLY + post-diagnostics ---------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-apply-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.js'), "import { track } from './t'\nexport const f = p => track('f', p)\n")
    writeFileSync(join(root, 'src', 'b.ts'), "import { track } from './t'\nexport const g = () => track('g', null)\n")
    const q = runStructureQuery(root, { select: 'call', callee: 'track' } as never)
    const pv = buildPreview(owner, q as never, undefined, {
      action: 'replace-callee',
      to: 'metrics.record',
    } as never) as { id: string }
    const applied = await applyPreview(owner, pv.id) as {
      state: string
      changedPaths?: string[]
      diagnostics?: { ok: boolean }[]
      evidenceRefs?: string[]
    }
    const landed =
      readFileSync(join(root, 'src', 'a.js'), 'utf8').includes("metrics.record('f', p)") &&
      readFileSync(join(root, 'src', 'b.ts'), 'utf8').includes("metrics.record('g', null)")
    const diagOk = (applied.diagnostics ?? []).every(d => d.ok)
    const ok = applied.state === 'applied' && (applied.changedPaths?.length ?? 0) === 2 && landed && diagOk
    const evRefs = applied.evidenceRefs ?? []
    const refs = [`mercury://structure/preview/${pv.id}`, ...evRefs]
    const resourcesResolved = ok && (await refsResolve(refs, root))
    const evRows = evidenceFor(owner).filter(e => e.claim.includes(pv.id))
    const evidencePresent =
      evRows.some(e => e.kind === 'change') && evRows.some(e => e.kind === 'check')
    const cleanup = removeTree(root)
    push({
      id: 'codemod-apply',
      capability: 'Multi-file codemod apply + post-diagnostics (Structure tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: applied.state === 'applied' ? 0 : 1,
      falseSuccess: applied.state === 'applied' && !landed, // "applied" without the edit landing
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(applied),
      outputBounded: sizeOf(applied) < OUTPUT_BOUND,
      expectedResources: refs.length,
      resourcesResolved,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 2,
      evidencePresent,
      cleanup,
      note: 'both files rewritten, parse diagnostics clean, change+check evidence',
    })
  }

  // ---- 4. STALE codemod rejection ------------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-stale-'))
    mkdirSync(join(root, 'src'))
    const A = "import { track } from './t'\nexport const f = p => track('f', p)\n"
    writeFileSync(join(root, 'src', 'a.js'), A)
    const q = runStructureQuery(root, { select: 'call', callee: 'track' } as never)
    const pv = buildPreview(owner, q as never, undefined, {
      action: 'replace-callee',
      to: 'metrics.record',
    } as never) as { id: string }
    writeFileSync(join(root, 'src', 'a.js'), `${A}// drift\n`) // change AFTER preview
    const stale = await applyPreview(owner, pv.id) as { state: string; code?: string }
    const refused = stale.state === 'refused' && stale.code === 'stale'
    const wroteNothing = readFileSync(join(root, 'src', 'a.js'), 'utf8') === `${A}// drift\n`
    const ok = refused && wroteNothing
    const cleanup = removeTree(root)
    push({
      id: 'stale-codemod-reject',
      capability: 'Stale-preview refusal (Structure tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: 0,
      falseSuccess: stale.state === 'applied', // an apply-through on a drifted file
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(stale),
      outputBounded: sizeOf(stale) < OUTPUT_BOUND,
      expectedResources: 0,
      resourcesResolved: true,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 0,
      evidencePresent: true,
      cleanup,
      note: 'drifted file refuses apply (code=stale), nothing written',
    })
  }

  // ---- 5. mixed-tree git inspection ----------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-gstat-'))
    git(root, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'seed'])
    appendFileSync(join(root, 'a.txt'), 'staged\n')
    git(root, ['add', 'a.txt'])
    appendFileSync(join(root, 'a.txt'), 'unstaged\n')
    writeFileSync(join(root, 'new.txt'), 'fresh\n')
    const st = gitStatus(root) as {
      state?: string
      files?: { path: string; staged?: string; unstaged?: string; kind?: string }[]
    }
    const ok =
      !('state' in st) &&
      !!st.files?.some(f => f.path === 'a.txt' && f.staged === 'M' && f.unstaged === 'M') &&
      !!st.files?.some(f => f.path === 'new.txt' && f.kind === 'untracked')
    const cleanup = removeTree(root)
    push({
      id: 'git-inspect-mixed',
      capability: 'Mixed working-tree inspection (Git tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: 'state' in st ? 1 : 0,
      falseSuccess: false,
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(st),
      outputBounded: sizeOf(st) < OUTPUT_BOUND,
      expectedResources: 0,
      resourcesResolved: true,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 0,
      evidencePresent: true,
      cleanup,
      note: 'staged+unstaged+untracked typed exactly',
    })
  }

  // ---- 6. atomic 2-group commit plan ---------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-plan-'))
    git(root, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(root, 'core.ts'), 'export const core = 1\n')
    writeFileSync(join(root, 'docs.md'), '# docs\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'seed'])
    appendFileSync(join(root, 'core.ts'), 'export const extra = 2\n')
    appendFileSync(join(root, 'docs.md'), 'more docs\n')
    writeFileSync(join(root, 'leftover.txt'), 'stays\n')
    const plan = preparePlan(owner, root, [
      { files: ['core.ts'], message: 'feat: core extra' },
      { files: ['docs.md'], message: 'docs: more' },
    ]) as { id: string; reason?: string }
    const preCount = git(root, ['rev-list', '--count', 'HEAD']).trim()
    const applied = applyPlan(owner, plan.id) as {
      state: string
      commits?: { sha: string; files: string[]; transactionId: string }[]
    }
    const commits = applied.commits ?? []
    const exact =
      commits.length === 2 &&
      JSON.stringify(commits[0]!.files) === JSON.stringify(['core.ts']) &&
      JSON.stringify(commits[1]!.files) === JSON.stringify(['docs.md'])
    const leftoverSurvives =
      readFileSync(join(root, 'leftover.txt'), 'utf8') === 'stays\n' &&
      git(root, ['status', '--porcelain']).includes('leftover.txt')
    const ok = applied.state === 'applied' && preCount === '1' && exact && leftoverSurvives
    const refs = [
      ...commits.map(c => `mercury://git/commit/${c.sha}`),
      `mercury://git/plan/${plan.id}`,
    ]
    const resourcesResolved = ok && (await refsResolve(refs, root))
    let settled = true
    for (const c of commits) {
      const txn = transactionsFor(owner).find(x => x.id === c.transactionId)
      if (!(txn?.state === 'settled' && txn.kind === 'git.commit' && txn.effectRef !== undefined)) {
        settled = false
      }
    }
    const changeEvidence = evidenceFor(owner).filter(e => e.kind === 'change').length
    const cleanup = removeTree(root)
    push({
      id: 'git-commit-plan',
      capability: 'Atomic multi-commit plan (Git tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: applied.state === 'applied' ? 0 : 1,
      falseSuccess: applied.state === 'applied' && !exact,
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(applied),
      outputBounded: sizeOf(applied) < OUTPUT_BOUND,
      expectedResources: refs.length,
      resourcesResolved,
      expectedTransactions: 2,
      transactionsSettled: settled && commits.length === 2,
      expectedEvidence: 2,
      evidencePresent: changeEvidence >= 2,
      cleanup,
      note: '2 exact commits, dependency order, 2 settled git.commit txns w/ effect',
    })
  }

  // ---- 7. plan DRIFT rejection ---------------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-pdrift-'))
    git(root, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(root, 'core.ts'), 'export const core = 1\n')
    writeFileSync(join(root, 'docs.md'), '# docs\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'seed'])
    appendFileSync(join(root, 'core.ts'), 'export const extra = 2\n')
    const plan = preparePlan(owner, root, [{ files: ['core.ts'], message: 'feat: later' }]) as {
      id: string
    }
    appendFileSync(join(root, 'docs.md'), 'drift\n') // tree changes AFTER prepare
    const preCount = git(root, ['rev-list', '--count', 'HEAD']).trim()
    const stale = applyPlan(owner, plan.id) as { state: string; code?: string }
    const nothingCommitted = git(root, ['rev-list', '--count', 'HEAD']).trim() === preCount
    const ok = stale.state === 'refused' && stale.code === 'stale' && nothingCommitted
    const cleanup = removeTree(root)
    push({
      id: 'git-plan-drift-reject',
      capability: 'Plan drift refusal (Git tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: 0,
      falseSuccess: stale.state === 'applied',
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(stale),
      outputBounded: sizeOf(stale) < OUTPUT_BOUND,
      expectedResources: 0,
      resourcesResolved: true,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 0,
      evidencePresent: true,
      cleanup,
      note: 'drifted tree refuses plan (code=stale), committed nothing',
    })
  }

  // ---- 8. conflict fixture resolution --------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const root = mkdtempSync(join(tmpdir(), 'builtin-tools-b-conf-'))
    git(root, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'seed'])
    git(root, ['checkout', '--quiet', '-b', 'side'])
    writeFileSync(join(root, 'a.txt'), 'one\nSIDE\nthree\n')
    git(root, ['commit', '--quiet', '-am', 'side'])
    git(root, ['checkout', '--quiet', 'main'])
    writeFileSync(join(root, 'a.txt'), 'one\nMAIN\nthree\n')
    git(root, ['commit', '--quiet', '-am', 'main'])
    let merged = false
    try {
      git(root, ['merge', '--quiet', 'side'])
      merged = true
    } catch {
      /* conflict arranged */
    }
    const conf = gitConflicts(root) as { path: string }[]
    const evBefore = evidenceFor(owner).length
    const res = resolveConflict(owner, root, 'a.txt', { take: 'ours' }) as { state: string }
    const cleared = gitStatus(root) as { state?: string; files?: { kind?: string }[] }
    const ok =
      !merged &&
      Array.isArray(conf) &&
      conf.length === 1 &&
      res.state === 'ok' &&
      readFileSync(join(root, 'a.txt'), 'utf8').includes('MAIN') &&
      !('state' in cleared) &&
      !cleared.files?.some(f => f.kind === 'unmerged')
    const evidencePresent = evidenceFor(owner).length - evBefore >= 1
    const cleanup = removeTree(root)
    push({
      id: 'git-conflict-resolve',
      capability: 'Merge-conflict resolution (Git tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: res.state === 'ok' ? 0 : 1,
      falseSuccess: res.state === 'ok' && cleared.files?.some(f => f.kind === 'unmerged') === true,
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(conf),
      outputBounded: sizeOf(conf) < OUTPUT_BOUND,
      expectedResources: 0,
      resourcesResolved: true,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 1,
      evidencePresent,
      cleanup,
      note: 'three-way conflict, resolve(ours) stages + clears the index',
    })
  }

  // ---- 9. start + verify a local service journey ---------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const port = PORT_BASE
    killPort(port) // reap any stale holder from a prior crashed run
    const { root, start } = writeFixture('builtin-b-jgood-', port)
    const j = (await runJourney(
      {
        objective: 'verify the fixture end to end',
        steps: [
          start,
          { kind: 'service.wait', name: 'fx' },
          {
            kind: 'http.request',
            url: `http://127.0.0.1:${port}/health`,
            expect: { status: 200, bodyIncludes: '"ok":true' },
          },
          { kind: 'service.stop', name: 'fx' },
        ],
      } as never,
      { owner, root },
    )) as { id: string; state: string; steps: { state: string }[]; evidenceRefs: string[] }
    const journeyRef = `mercury://journey/${j.id}`
    const resourcesResolved = j.state === 'succeeded' && (await refsResolve([journeyRef], root))
    const evidenceOk =
      j.evidenceRefs.length >= 4 && (await refsResolve(j.evidenceRefs, root))
    const execOk = getExecution(owner, j.id)?.state === 'succeeded'
    const reaped = !portAlive(port)
    const ok = j.state === 'succeeded' && j.steps.every(s => s.state === 'passed') && execOk && reaped
    killPort(port)
    const cleanup: 'ok' | 'failed' = removeTree(root) === 'ok' && reaped ? 'ok' : 'failed'
    push({
      id: 'journey-service-verify',
      capability: 'Start + verify a local service (Journey tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: j.steps.filter(s => s.state !== 'passed').length,
      falseSuccess: j.state === 'succeeded' && !j.steps.every(s => s.state === 'passed'),
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(j),
      outputBounded: sizeOf(j) < OUTPUT_BOUND,
      expectedResources: 1,
      resourcesResolved,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: j.evidenceRefs.length,
      evidencePresent: evidenceOk,
      cleanup,
      note: 'boot→ready→http 200→stop, execution settled succeeded, service reaped',
    })
  }

  // ---- 10. detect a wrong HTTP response ------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const port = PORT_BASE + 1
    killPort(port) // reap any stale holder from a prior crashed run
    const { root, start } = writeFixture('builtin-b-jbad-', port)
    const j = (await runJourney(
      {
        objective: 'detect a wrong http status',
        steps: [
          start,
          { kind: 'service.wait', name: 'fx' },
          { kind: 'http.request', url: `http://127.0.0.1:${port}/broken`, expect: { status: 200 } },
          { kind: 'command.run', command: process.execPath, args: ['-e', '1'], label: 'never' },
        ],
      } as never,
      { owner, root },
    )) as {
      id: string
      state: string
      failedStep?: number
      steps: { state: string; detail: string }[]
      evidenceRefs: string[]
      cleanup: { service: string; action: string }[]
    }
    const journeyRef = `mercury://journey/${j.id}`
    const detected =
      j.state === 'failed' &&
      j.failedStep === 2 &&
      j.steps[2]!.detail.includes('500') &&
      j.steps[3]!.state === 'skipped'
    const resourcesResolved = await refsResolve([journeyRef], root)
    const reaped = !portAlive(port)
    const ok = detected && execFailed(j.id) && reaped
    killPort(port)
    const cleanup: 'ok' | 'failed' = removeTree(root) === 'ok' && reaped ? 'ok' : 'failed'
    push({
      id: 'journey-detect-bad-http',
      capability: 'Detect a wrong HTTP response (Journey tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: 0, // the 500 is the DESIGNED fault the journey must catch
      falseSuccess: j.state === 'succeeded', // a fake pass on a 500 body
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(j),
      outputBounded: sizeOf(j) < OUTPUT_BOUND,
      expectedResources: 1,
      resourcesResolved,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 1,
      evidencePresent: j.evidenceRefs.length >= 1 && (await refsResolve(j.evidenceRefs, root)),
      cleanup,
      note: 'status 500≠200 fails honestly, later step skipped, service reaped',
    })
  }

  // ---- 11. cancel a running journey ----------------------------------------
  {
    resetPlanes()
    const t0 = performance.now()
    const port = PORT_BASE + 2
    killPort(port) // reap any stale holder from a prior crashed run
    const { root, start } = writeFixture('builtin-b-jcancel-', port)
    const ac = new AbortController()
    const p = runJourney(
      {
        objective: 'cancel mid-journey',
        steps: [
          start,
          { kind: 'service.wait', name: 'fx' },
          {
            kind: 'command.run',
            command: process.execPath,
            args: ['-e', 'setTimeout(()=>{}, 30000)'],
            timeoutMs: 25_000,
          },
          { kind: 'http.request', url: `http://127.0.0.1:${port}/health` },
        ],
      } as never,
      { owner, root, signal: ac.signal },
    ) as Promise<{ id: string; state: string; cleanup: { service: string }[] }>
    setTimeout(() => ac.abort(), 1_200)
    const j = await p
    const journeyRef = `mercury://journey/${j.id}`
    const reaped = !portAlive(port)
    const cancelledClean =
      j.state === 'cancelled' &&
      getExecution(owner, j.id)?.state === 'cancelled' &&
      cancelJourney(owner, j.id) === false &&
      reaped
    const resourcesResolved = await refsResolve([journeyRef], root)
    const ok = cancelledClean
    killPort(port)
    const cleanup: 'ok' | 'failed' = removeTree(root) === 'ok' && reaped ? 'ok' : 'failed'
    push({
      id: 'journey-cancel',
      capability: 'Cancel a running journey (Journey tool)',
      toolPath: 'tool-level',
      completed: ok,
      retries: 0,
      failedOperations: 0,
      falseSuccess: j.state === 'succeeded', // a cancel must never settle as success
      elapsedMs: performance.now() - t0,
      outputBytes: sizeOf(j),
      outputBounded: sizeOf(j) < OUTPUT_BOUND,
      expectedResources: 1,
      resourcesResolved,
      expectedTransactions: 0,
      transactionsSettled: true,
      expectedEvidence: 0,
      evidencePresent: true,
      cleanup,
      note: 'abort settles cancelled, execution cancelled, service reaped',
    })
  }

  // ---- 12–15. capability discovery via ToolSearch --------------------------
  {
    const catalog = getAllBaseTools()
    const queries: { id: string; query: string; want: string; capability: string }[] = [
      {
        id: 'discover-structure',
        query: 'query the AST for call expressions and apply a codemod across files',
        want: 'Structure',
        capability: 'Retrieve the Structure tool by intent (ToolSearch)',
      },
      {
        id: 'discover-git',
        query: 'split my working changes into atomic stale-safe git commits',
        want: 'Git',
        capability: 'Retrieve the Git tool by intent (ToolSearch)',
      },
      {
        id: 'discover-journey',
        query: 'start a local service and assert an http response end to end',
        want: 'Journey',
        capability: 'Retrieve the Journey tool by intent (ToolSearch)',
      },
      {
        id: 'discover-test',
        query: 'run the pytest test suite and rerun failed tests',
        want: 'Test',
        capability: 'Retrieve the Test tool by intent (ToolSearch)',
      },
    ]
    for (const { id, query, want, capability } of queries) {
      const t0 = performance.now()
      const results = await searchToolsWithKeywords(query, catalog, catalog, 5)
      const ok = results[0] === want
      push({
        id,
        capability,
        toolPath: 'tool-level',
        completed: ok,
        retries: 0,
        failedOperations: ok ? 0 : 1,
        falseSuccess: false,
        elapsedMs: performance.now() - t0,
        outputBytes: sizeOf(results),
        outputBounded: sizeOf(results) < OUTPUT_BOUND,
        expectedResources: 0,
        resourcesResolved: true,
        expectedTransactions: 0,
        transactionsSettled: true,
        expectedEvidence: 0,
        evidencePresent: true,
        cleanup: 'n/a',
        note: `intent → '${want}' ranked #1 of ${results.length}`,
      })
    }
  }

  resetPlanes()
  return tasks
}

// A real loopback HTTP fixture: /health → 200 {ok:true}, else 500. Logs a
// READY line + a line per hit. Returns the temp root + the service.start step.
function writeFixture(prefix: string, port: number): { root: string; start: unknown } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(
    join(root, 'server.mjs'),
    `import { createServer } from 'node:http'
const srv = createServer((req, res) => {
  console.log('hit ' + req.url)
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true})); return }
  res.writeHead(500); res.end('boom')
})
srv.listen(${port}, '127.0.0.1', () => console.log('FIXTURE READY ${port}'))
`,
  )
  return {
    root,
    start: {
      kind: 'service.start',
      name: 'fx',
      command: process.execPath,
      args: ['server.mjs'],
      readiness: [{ kind: 'log', regex: 'FIXTURE READY' }],
    },
  }
}

function execFailed(id: string): boolean {
  return getExecution(owner, id)?.state === 'failed'
}

/** Remove the hermetic bench homes created at module load (the gate calls this
 *  in its finally — the CLI does it inline). */
export function cleanupBenchHomes(): void {
  rmSync(CONFIG_HOME, { recursive: true, force: true })
  rmSync(DAEMON_HOME, { recursive: true, force: true })
}

// ── the STABLE projection (the committed anchor) ────────────────────────────
// Capability facts + FIXED contract counts only. No timings, no byte counts —
// so it is byte-identical across runs and machines.
export interface StableRow {
  id: string
  capability: string
  toolPath: 'tool-level'
  completed: boolean
  retries: number
  failedOperations: number
  falseSuccess: boolean
  outputBounded: boolean
  expectedResources: number
  resourcesResolved: boolean
  expectedTransactions: number
  transactionsSettled: boolean
  expectedEvidence: number
  evidencePresent: boolean
  cleanup: 'ok' | 'failed' | 'n/a'
}

export interface StableAnchor {
  schema: 1
  corpus: string
  totalTasks: number
  completed: number
  falseSuccesses: number
  rows: StableRow[]
}

export function stableProjection(tasks: TaskResult[]): StableAnchor {
  const rows: StableRow[] = tasks.map(t => ({
    id: t.id,
    capability: t.capability,
    toolPath: t.toolPath,
    completed: t.completed,
    retries: t.retries,
    failedOperations: t.failedOperations,
    falseSuccess: t.falseSuccess,
    outputBounded: t.outputBounded,
    expectedResources: t.expectedResources,
    resourcesResolved: t.resourcesResolved,
    expectedTransactions: t.expectedTransactions,
    transactionsSettled: t.transactionsSettled,
    expectedEvidence: t.expectedEvidence,
    evidencePresent: t.evidencePresent,
    cleanup: t.cleanup,
  }))
  return {
    schema: 1,
    corpus: 'builtin-tool-capability',
    totalTasks: rows.length,
    completed: rows.filter(r => r.completed).length,
    falseSuccesses: rows.filter(r => r.falseSuccess).length,
    rows,
  }
}

export function anchorJson(anchor: StableAnchor): string {
  return `${JSON.stringify(anchor, null, 2)}\n`
}

function bucket(ms: number): string {
  if (ms < 1_000) return '<1s'
  if (ms <= 5_000) return '1-5s'
  return '>5s'
}

export function renderResultsMd(tasks: TaskResult[], anchor: StableAnchor): string {
  const done = anchor.completed
  const total = anchor.totalTasks
  const pct = (n: number, d: number): string => (d === 0 ? '100' : ((n / d) * 100).toFixed(0))
  const resTasks = tasks.filter(t => t.expectedResources > 0)
  const txnTasks = tasks.filter(t => t.expectedTransactions > 0)
  const evTasks = tasks.filter(t => t.expectedEvidence > 0)
  const cleanupTasks = tasks.filter(t => t.cleanup !== 'n/a')
  const lines: string[] = []
  lines.push('# builtin-tools — tool-capability benchmark results')
  lines.push('')
  lines.push(
    '_Generated by `bun run scripts/builtin-tools/bench-builtin-tools.ts --write`. Do not hand-edit — ' +
      'regenerate. Exact timings are console-only; this file buckets them for stability._',
  )
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push(`- **Tasks completed:** ${done}/${total} (${pct(done, total)}%)`)
  lines.push(`- **False successes:** ${anchor.falseSuccesses} (a failed step summarized as success)`)
  lines.push(
    `- **Resource completeness:** ${resTasks.filter(t => t.resourcesResolved).length}/${resTasks.length} tasks — every minted mercury:// ref resolves`,
  )
  lines.push(
    `- **Transaction completeness:** ${txnTasks.filter(t => t.transactionsSettled).length}/${txnTasks.length} tasks — every expected transaction settled with an observed effect`,
  )
  lines.push(
    `- **Evidence completeness:** ${evTasks.filter(t => t.evidencePresent).length}/${evTasks.length} tasks — every expected evidence row present on the ONE plane`,
  )
  lines.push(
    `- **Cleanup correctness:** ${cleanupTasks.filter(t => t.cleanup === 'ok').length}/${cleanupTasks.length} tasks — temp trees removed, no surviving processes`,
  )
  lines.push('')
  lines.push('## Corpus')
  lines.push('')
  lines.push(
    '| Task | Capability | Done | Retries | FailedOps | FalseSuccess | Resources | Txns | Evidence | Cleanup | Time |',
  )
  lines.push(
    '|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|',
  )
  for (const t of tasks) {
    const res =
      t.expectedResources > 0 ? `${t.resourcesResolved ? t.expectedResources : 0}/${t.expectedResources}` : '—'
    const txn =
      t.expectedTransactions > 0
        ? `${t.transactionsSettled ? t.expectedTransactions : 0}/${t.expectedTransactions}`
        : '—'
    const ev = t.expectedEvidence > 0 ? `${t.evidencePresent ? t.expectedEvidence : 0}/${t.expectedEvidence}` : '—'
    lines.push(
      `| \`${t.id}\` | ${t.capability} | ${t.completed ? 'yes' : 'NO'} | ${t.retries} | ${t.failedOperations} | ${t.falseSuccess ? 'YES' : 'no'} | ${res} | ${txn} | ${ev} | ${t.cleanup} | ${bucket(t.elapsedMs)} |`,
    )
  }
  lines.push('')
  lines.push(
    '_Notes per task are in the runner._',
  )
  lines.push('')
  return lines.join('\n')
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const write = process.argv.includes('--write')
  const tasks = await runCorpus()
  const anchor = stableProjection(tasks)

  // console: exact timings + per-dimension facts
  console.log('── builtin-tools tool-capability benchmark ──')
  for (const t of tasks) {
    console.log(
      `  [${t.completed ? 'DONE' : 'MISS'}] ${t.id.padEnd(26)} ` +
        `${t.elapsedMs.toFixed(0).padStart(5)}ms  ` +
        `false=${t.falseSuccess ? 'YES' : 'no '} ` +
        `res=${t.resourcesResolved ? t.expectedResources : 'X'}/${t.expectedResources} ` +
        `txn=${t.transactionsSettled ? t.expectedTransactions : 'X'}/${t.expectedTransactions} ` +
        `ev=${t.evidencePresent ? t.expectedEvidence : 'X'}/${t.expectedEvidence} ` +
        `clean=${t.cleanup} bytes=${t.outputBytes}`,
    )
  }
  console.log(
    `  headline: ${anchor.completed}/${anchor.totalTasks} completed · ${anchor.falseSuccesses} false-successes`,
  )

  if (write) {
    const outDir = join(repoRoot, 'scripts', 'builtin-tools', 'fixtures')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'results.json'), anchorJson(anchor))
    writeFileSync(join(outDir, 'RESULTS.md'), renderResultsMd(tasks, anchor))
    console.log(`  wrote ${join(outDir, 'results.json')}`)
    console.log(`  wrote ${join(outDir, 'RESULTS.md')}`)
  }

  // hermetic cleanup of the bench homes we created
  rmSync(CONFIG_HOME, { recursive: true, force: true })
  rmSync(DAEMON_HOME, { recursive: true, force: true })
}
