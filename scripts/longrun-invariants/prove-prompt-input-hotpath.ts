#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-prompt-input-hotpath.ts — the hot-path tranche
//
//
//  K1/K1a — the run listing read + statted every historical run through one
//  unbounded Promise.all (one fd per run; past the process limit every
//  EMFILE was swallowed as "no manifest" and the listing resolved as if
//  complete) and offered callers no limit. Now: bounded fan-out, newest-N
//  candidate selection by manifest mtime, and an honest {rows, unreadable}
//  shape consumers surface as PARTIAL.
//  K2 — four callers swept lifetime history and bounded after; the bus and
//  the model-facing listing now pass their bound in.
//  K3 — the board polled and repainted beneath nested views, and an
//  unchanged sweep still wrote state; now suspended off-board and
//  identity-stable on unchanged listings.
//  K4 — every telemetry refresh minted seven fresh slices and notified all
//  subscribers; now unchanged slices keep identity and a no-op refresh
//  emits nothing.
//  K5/K6/K7/K10a — per-tick row derivation with a pidAlive probe per row,
//  the unparked board clock, per-row private intervals, and window counts
//  presented as totals — memoized / parked / shared-clock / lower-bound
//  labeled respectively.
// ============================================================================
import { execSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'kinetic-hotpath-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { listWorkflowRuns, listWorkflowRunsDetailed, workflowRunsRoot } = await import(
  '../../src/tools/WorkflowTool/runManifest.js'
)
const { sameRunListing } = await import('../../src/components/tasks/WorkflowsBoard.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function seedRuns(cwd: string, n: number): void {
  const root = workflowRunsRoot(cwd)
  for (let i = 1; i <= n; i++) {
    const dir = join(root, `wf_${String(i).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'run.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        runId: `wf_${String(i).padStart(3, '0')}`,
        runDir: dir,
        startTime: 1_000_000 + i * 1000,
        status: 'completed',
        ownerPid: 1,
        agentCount: 0,
        totalTokens: 0,
        totalToolCalls: 0,
        agents: [],
      }),
    )
    // staggered COARSE mtimes: newest startTime ⇔ newest mtime (the proxy law)
    const t = new Date(1_700_000_000_000 + i * 2000)
    utimesSync(file, t, t)
  }
}

section('K1 — the limit selects the newest-N and reads only those')
{
  const cwd = mkdtempSync(join(tmpdir(), 'kinetic-list-'))
  seedRuns(cwd, 30)
  const all = await listWorkflowRuns(cwd)
  check('unlimited listing returns every run, newest-first', all.length === 30 && all[0]!.runId === 'wf_030')
  const { rows, unreadable } = await listWorkflowRunsDetailed(cwd, { limit: 5 })
  check('limit 5 returns exactly the 5 newest by startTime',
    rows.length === 5 && rows.map(r => r.runId).join(',') === 'wf_030,wf_029,wf_028,wf_027,wf_026',
    rows.map(r => r.runId).join(','))
  check('a clean listing reports zero unreadable', unreadable === 0)
  check('a tiny concurrency still completes correctly', (
    await listWorkflowRunsDetailed(cwd, { limit: 5, concurrency: 2 })
  ).rows.length === 5)
  rmSync(cwd, { recursive: true, force: true })
}

section('K1a — an I/O-failed manifest is COUNTED, never silently dropped')
{
  const cwd = mkdtempSync(join(tmpdir(), 'kinetic-unreadable-'))
  seedRuns(cwd, 4)
  // one manifest becomes unreadable (EACCES on read — the EMFILE-class shape)
  const blocked = join(workflowRunsRoot(cwd), 'wf_002', 'run.json')
  chmodSync(blocked, 0o000)
  const { rows, unreadable } = await listWorkflowRunsDetailed(cwd)
  check('the readable rows still return', rows.length === 3, String(rows.length))
  check('the failed read is COUNTED as unreadable (partial listing, said so)',
    unreadable === 1, String(unreadable))
  chmodSync(blocked, 0o644)
  // absence keeps its historical skip semantics — never counted unreadable
  mkdirSync(join(workflowRunsRoot(cwd), 'wf_empty_dir'), { recursive: true })
  const after = await listWorkflowRunsDetailed(cwd)
  check('a dir with NO manifest is a skip, not an unreadable',
    after.rows.length === 4 && after.unreadable === 0, JSON.stringify({ n: after.rows.length, u: after.unreadable }))
  rmSync(cwd, { recursive: true, force: true })
}

section('K3 — unchanged sweeps are identity-stable; the poll parks off-board')
{
  const a = [
    { runId: 'r1', mtimeMs: 10, status: 'completed' },
    { runId: 'r2', mtimeMs: 20, status: 'running' },
  ] as never[]
  const same = [
    { runId: 'r1', mtimeMs: 10, status: 'completed' },
    { runId: 'r2', mtimeMs: 20, status: 'running' },
  ] as never[]
  const moved = [
    { runId: 'r1', mtimeMs: 10, status: 'completed' },
    { runId: 'r2', mtimeMs: 25, status: 'running' },
  ] as never[]
  check('an unchanged listing compares equal (no state write)', sameRunListing(a, same) === true)
  check('a heartbeat re-stamp is a change', sameRunListing(a, moved) === false)
  check('a settled status flip is a change', sameRunListing(a, [
    { runId: 'r1', mtimeMs: 10, status: 'completed' },
    { runId: 'r2', mtimeMs: 20, status: 'killed' },
  ] as never[]) === false)
  const board = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'WorkflowsBoard.tsx'),
    'utf8',
  )
  check('the poll is suspended beneath nested views', board.includes('if (!onBoard) return'))
  check('an unchanged sweep keeps the previous array identity',
    board.includes('sameRunListing(prev, listing.rows) ? prev : listing.rows'))
}

section('K4 — unmoved slices keep identity; the notify pulse always fires')
{
  const bus = readFileSync(join(import.meta.dir, '..', '..', 'src', 'state', 'telemetryBus.ts'), 'utf8')
  check('unchanged slices are dropped before assignment (identity holds)',
    bus.includes('if (jsonStringify(prev) === jsonStringify(fresh))'))
  // K4 CORRECTION: the original skip-emit clause severed the
  // rails' repaint pulse — they render sync-read caches with no own
  // subscription, fresh only because this notify repainted their reader.
  // The corrected law: identity-stable slices + an unconditional notify.
  check('the heartbeat notify ALWAYS fires (sync-read surfaces ride the pulse)',
    !bus.includes('if (!changed) return') && bus.includes('K4 CORRECTION'))
  check('the selector overload exists for slice-scoped subscribers',
    bus.includes('export function useTelemetry<T>(selector: (s: TelemetrySnapshots) => T): T'))
  check('the bus passes its bound into the listing (never lifetime history)',
    bus.includes('listWorkflowRuns(getCwd(), { limit: WORKFLOWS_DISK_MAX * 5 })'))
}

section('K5/K6/K7/K10a — derivation cadence, parked clocks, shared timer, honest counts')
{
  const board = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'WorkflowsBoard.tsx'),
    'utf8',
  )
  // The runner-liveness law: presence reads the roster, so the
  // memo re-derives on roster movement too — still data, never ticks.
  check('row derivation (incl. the pidAlive probes) is memoized on data, not ticks',
    board.includes('const derivedRows = React.useMemo(') && board.includes('}, [tasks, pastRuns, roster])'))
  check('the board clock parks when nothing is in motion',
    board.includes('useNowTick(boardHasMotion ? 1000 : null)'))
  check('the partial listing is SAID on the Past section',
    board.includes('unreadable — partial'))
  const hook = readFileSync(join(import.meta.dir, '..', '..', 'src', 'hooks', 'useElapsedTime.ts'), 'utf8')
  check('useElapsedTime rides the shared quantized clock (no private interval)',
    hook.includes('return subscribeUiClock(ms, notify)') && !/= setInterval\(/.test(hook))
  const insp = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'AgentInspectorPane.tsx'),
    'utf8',
  )
  check("head+tail window counts are labeled lower bounds ('+')",
    insp.includes("${view.truncatedRead ? '+' : ''}"))
  const adapter = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'resources', 'adapters', 'agent.ts'),
    'utf8',
  )
  check('the agent ref summary labels window counts too',
    adapter.includes("${view.truncatedRead ? '+' : ''} tool call(s)"))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} kinetic HOT-PATH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL kinetic HOT-PATH PROOFS PASS')
process.exit(0)
