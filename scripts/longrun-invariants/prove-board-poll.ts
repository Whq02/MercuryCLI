#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'board-poll-home-'))

const { createPastRunsLoader } = await import('../../src/components/tasks/WorkflowsBoard.js')
const { listWorkflowRuns, workflowRunsRoot } = await import(
  '../../src/tools/WorkflowTool/runManifest.js'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

section('§A the guarded loader: single-flight, no stale apply, fresh after settle')
{
  let resolveList: ((v: string) => void) | undefined
  let listCalls = 0
  const applied: string[] = []
  const loader = createPastRunsLoader<string>({
    list: () =>
      new Promise<string>(r => {
        listCalls++
        resolveList = r
      }),
    apply: v => applied.push(v),
  })
  loader.load()
  loader.load()
  loader.load()
  check('three ticks during one slow scan start ONE list call', listCalls === 1, String(listCalls))
  resolveList!('scan-1')
  await sleep(0)
  check('the settled scan applied', applied.join(',') === 'scan-1')
  loader.load()
  check('after settle, the next tick scans again', listCalls === 2)
  resolveList!('scan-2')
  await sleep(0)
  check('the fresh scan applied in order', applied.join(',') === 'scan-1,scan-2')
}
{
  let resolveList: ((v: string) => void) | undefined
  const applied: string[] = []
  const loader = createPastRunsLoader<string>({
    list: () => new Promise<string>(r => (resolveList = r)),
    apply: v => applied.push(v),
  })
  loader.load()
  loader.dispose()
  resolveList!('late')
  await sleep(0)
  check('a scan resolving after dispose NEVER applies (unmount law)', applied.length === 0)
}
{
  let calls = 0
  const loader = createPastRunsLoader<string>({
    list: () => {
      calls++
      return calls === 1 ? Promise.reject(new Error('io')) : Promise.resolve('ok')
    },
    apply: () => {},
  })
  loader.load()
  await sleep(0)
  loader.load()
  check('a rejected scan releases the in-flight latch (poll survives)', calls === 2, String(calls))
}

section('§B listWorkflowRuns: unchanged run.json is not re-parsed; heartbeat invalidates')
{
  const cwd = mkdtempSync(join(tmpdir(), 'board-poll-runs-'))
  const root = workflowRunsRoot(cwd)
  const dirA = join(root, 'wf_a')
  mkdirSync(dirA, { recursive: true })
  const manifest = (status: string, tokens: number): string =>
    JSON.stringify({
      version: 1,
      runId: 'wf_a',
      runDir: dirA,
      startTime: 1000,
      status,
      ownerPid: process.pid,
      agentCount: 1,
      totalTokens: tokens,
      totalToolCalls: 0,
      agents: [],
    })
  const file = join(dirA, 'run.json')
  writeFileSync(file, manifest('running', 100))
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
  utimesSync(file, pinned, pinned)

  const first = await listWorkflowRuns(cwd)
  check('cold list reads the manifest', first.length === 1 && first[0]!.totalTokens === 100)

  const st = statSync(file)
  writeFileSync(file, manifest('running', 999))
  utimesSync(file, pinned, pinned)
  const second = await listWorkflowRuns(cwd)
  check(
    'unchanged mtime ⇒ served from the parse cache (content not re-read)',
    second[0]!.totalTokens === 100,
    String(second[0]!.totalTokens),
  )
  check(
    'each poll hands out a FRESH top-level object (kinetic-F1 WeakMap law)',
    (first[0] as object) !== (second[0] as object),
  )

  const later = new Date(st.mtimeMs + 5_000)
  utimesSync(file, later, later)
  const third = await listWorkflowRuns(cwd)
  check(
    'a heartbeat re-stamp invalidates ⇒ fresh parse picks up the change',
    third[0]!.totalTokens === 999,
    String(third[0]!.totalTokens),
  )

  rmSync(dirA, { recursive: true, force: true })
  const fourth = await listWorkflowRuns(cwd)
  check('a deleted run disappears from the listing', fourth.length === 0)
  rmSync(cwd, { recursive: true, force: true })
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} BOARD-POLL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL BOARD-POLL PROOFS PASS')
