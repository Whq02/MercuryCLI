#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildAgentSummaries,
  embedArgs,
  isRunOrphaned,
  listWorkflowRuns,
  logsTail,
  partitionDiskRuns,
  readRunManifest,
  RUN_MANIFEST_STALE_MS,
  RUN_MANIFEST_VERSION,
  runLiveness,
  workflowRunsRoot,
  writeRunManifest,
  type WorkflowRunManifest,
} from '../../src/tools/WorkflowTool/runManifest.ts'
import type { WorkflowProgressEvent } from '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' workflow run manifest — restartable board listing + orphan check')
console.log('============================================================')

section('buildAgentSummaries — projection of coalesced workflow_agent events')
{
  const events: WorkflowProgressEvent[] = [
    { type: 'workflow_log', message: 'hello' },
    { type: 'workflow_phase', index: 1, title: 'Scan' },
    {
      type: 'workflow_agent',
      index: 2,
      label: 'verify',
      state: 'done',
      phaseIndex: 1,
      phaseTitle: 'Scan',
      tokens: 512,
      toolCalls: 7,
      durationMs: 9000,
      agentId: 'a1b2c3',
      agentType: 'workflow-subagent',
      model: 'sonnet',
      effort: 'high',
      attempt: 2,
      lastToolName: 'Bash',
      promptPreview: 'Verify the thing…',
    } as WorkflowProgressEvent,
    { type: 'workflow_agent', index: 1, label: 'scan', state: 'error', error: 'boom' },
  ]
  const s = buildAgentSummaries(events)
  check('projects only workflow_agent events', s.length === 2)
  check('sorted by index', s[0]!.index === 1 && s[1]!.index === 2)
  check('rich extras carried (agentId/model/effort/attempt/lastToolName)',
    s[1]!.agentId === 'a1b2c3' && s[1]!.model === 'sonnet' && s[1]!.effort === 'high' &&
    s[1]!.attempt === 2 && s[1]!.lastToolName === 'Bash')
  check('error carried', s[0]!.error === 'boom')
  check('non-string extras read defensively (absent, not fabricated)',
    s[0]!.agentId === undefined && s[0]!.model === undefined)
}

section('embedArgs / logsTail — bounded embedding')
{
  check('small args embedded verbatim', JSON.stringify(embedArgs({ a: 1 })) === JSON.stringify({ args: { a: 1 } }))
  const big = { blob: 'x'.repeat(20_000) }
  const e = embedArgs(big)
  check('oversized args → preview only', e.args === undefined && typeof e.argsPreview === 'string' && e.argsPreview.length <= 400)
  const cyc: Record<string, unknown> = {}; cyc.self = cyc
  check('unserializable args → honest marker', embedArgs(cyc).argsPreview === '<unserializable args>')
  check('undefined args → {}', Object.keys(embedArgs(undefined)).length === 0)
  check('logsTail keeps the last 20', logsTail(Array.from({ length: 50 }, (_, i) => `l${i}`)).length === 20)
}

section('write → read round-trip + listWorkflowRuns ordering (real files)')
const tmp = mkdtempSync(join(tmpdir(), 'wf-manifest-proof-'))
try {
  const root = workflowRunsRoot(tmp)
  const mk = (runId: string, startTime: number, status: WorkflowRunManifest['status']): WorkflowRunManifest => ({
    version: RUN_MANIFEST_VERSION,
    runId,
    runDir: join(root, runId),
    startTime,
    status,
    ownerPid: process.pid,
    agentCount: 1,
    totalTokens: 10,
    totalToolCalls: 2,
    agents: [],
  })
  await writeRunManifest(mk('wf_old', 1000, 'completed'))
  await writeRunManifest(mk('wf_new', 2000, 'running'))
  const back = await readRunManifest(join(root, 'wf_old'))
  check('round-trip preserves identity', back?.runId === 'wf_old' && back.status === 'completed' && back.version === RUN_MANIFEST_VERSION)
  check('reader reports a real mtime', typeof back?.mtimeMs === 'number' && back!.mtimeMs > 0)

  await mkdir(join(root, 'wf_torn'), { recursive: true })
  await writeFile(join(root, 'wf_torn', 'run.json'), '{"runId": "wf_torn", "ver', 'utf8')
  await mkdir(join(root, 'wf_future'), { recursive: true })
  await writeFile(join(root, 'wf_future', 'run.json'), JSON.stringify({ runId: 'wf_future', version: RUN_MANIFEST_VERSION + 1 }), 'utf8')
  const runs = await listWorkflowRuns(tmp)
  check('lists both valid runs, newest first', runs.length === 2 && runs[0]!.runId === 'wf_new' && runs[1]!.runId === 'wf_old')
  check('torn json + newer-major version skipped honestly', !runs.some(r => r.runId === 'wf_torn' || r.runId === 'wf_future'))
  check('missing root → empty list, no throw', (await listWorkflowRuns(join(tmp, 'nope'))).length === 0)

  const raceDir = join(root, 'wf_race')
  const raceManifest = (status: WorkflowRunManifest['status']): WorkflowRunManifest => ({
    ...mk('wf_race', 3000, status), runDir: raceDir,
  })
  let chain: Promise<void> = Promise.resolve()
  chain = chain.then(() => writeRunManifest(raceManifest('running')))
  chain = chain.then(() => writeRunManifest(raceManifest('completed')))
  await chain
  const raced = await readRunManifest(raceDir)
  check('serialized running→completed lands on completed (no stale-rename freeze)', raced?.status === 'completed')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

section('isRunOrphaned — truth table')
{
  const now = Date.now()
  const fresh = now - 1000
  const stale = now - RUN_MANIFEST_STALE_MS - 1000
  const alive = () => true
  const dead = () => false
  check('running + fresh heartbeat → NOT orphaned (regardless of pid)', !isRunOrphaned({ status: 'running', ownerPid: 1 }, fresh, now, dead))
  check('running + stale + dead pid → ORPHANED', isRunOrphaned({ status: 'running', ownerPid: 1 }, stale, now, dead))
  check('running + stale + live pid → not orphaned (slow writer, honest)', !isRunOrphaned({ status: 'running', ownerPid: 1 }, stale, now, alive))
  check('paused + stale + dead pid → NOT orphaned (settled on purpose)', !isRunOrphaned({ status: 'paused', ownerPid: 1 }, stale, now, dead))
  check('completed + stale → never orphaned', !isRunOrphaned({ status: 'completed', ownerPid: 1 }, stale, now, dead))
  check('pidAlive throwing → treated as orphaned (fail-honest)', isRunOrphaned({ status: 'running', ownerPid: 1 }, stale, now, () => { throw new Error('x') }))
}

section('runLiveness tri-state + partitionDiskRuns (trust-cockpit)')
{
  const now = Date.now()
  const fresh = now - 1000
  const stale = now - RUN_MANIFEST_STALE_MS - 1000
  const alive = () => true
  const dead = () => false
  check("running + stale + LIVE pid → 'wedged' (hung engine gets a word)", runLiveness({ status: 'running', ownerPid: 1 }, stale, now, alive) === 'wedged')
  check("running + stale + dead pid → 'orphaned'", runLiveness({ status: 'running', ownerPid: 1 }, stale, now, dead) === 'orphaned')
  check("running + fresh → 'live'", runLiveness({ status: 'running', ownerPid: 1 }, fresh, now, dead) === 'live')
  check("completed → 'live' (a settled manifest claims nothing)", runLiveness({ status: 'completed', ownerPid: 1 }, stale, now, dead) === 'live')
  check('pidAlive throwing → orphaned (fail-honest)', runLiveness({ status: 'running', ownerPid: 1 }, stale, now, () => { throw new Error('x') }) === 'orphaned')

  const mk = (runId: string, status: 'running' | 'completed', mtimeMs: number, ownerPid = 1) =>
    ({ runId, status, ownerPid, mtimeMs })
  const rows = [
    mk('local-running', 'running', fresh),
    mk('ext-running', 'running', fresh),
    mk('ext-wedged', 'running', stale),
    mk('ext-orphaned', 'running', stale, 2),
    mk('done', 'completed', stale),
  ]
  const pidAlive = (pid: number) => pid !== 2
  const { external, past } = partitionDiskRuns(rows, new Set(['local-running']), now, pidAlive)
  check('local AppState-tracked run dropped from both', !external.some(m => m.runId === 'local-running') && !past.some(m => m.runId === 'local-running'))
  check("running-elsewhere files EXTERNAL 'live'", external.some(m => m.runId === 'ext-running' && m.liveness === 'live'))
  check("hung-elsewhere files EXTERNAL 'wedged'", external.some(m => m.runId === 'ext-wedged' && m.liveness === 'wedged'))
  check('orphaned claims-running files PAST (stale render, never a spinner)', past.some(m => m.runId === 'ext-orphaned'))
  check('settled files PAST', past.some(m => m.runId === 'done'))
  check('partition is total (drop-local aside, nothing vanishes)', external.length + past.length === rows.length - 1)
}

section('source: WorkflowTool.tsx wiring (bun-unloadable — text pins)')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'WorkflowTool.tsx'), 'utf-8')
  check('initial manifest write at launch', /const writeManifest = \(/.test(src) && /if \(!\(await writeManifest\(\)\)\) \{/.test(src))
  check('flush path re-stamps, throttled', /RUN_MANIFEST_WRITE_THROTTLE_MS\)\s*\{\s*writeManifest\(\)/.test(src))
  check('a flush inside the throttle schedules the trailing write for the throttle\'s end', /trailingManifestWrite = setTimeout\(/.test(src) && /RUN_MANIFEST_WRITE_THROTTLE_MS - sinceLast/.test(src))
  check('the trailing write is cleared with the heartbeat', /clearInterval\(manifestHeartbeat\)\s*\n\s*if \(trailingManifestWrite !== null\) clearTimeout\(trailingManifestWrite\)/.test(src))
  check('heartbeat interval while running', /setInterval\(\s*\(\) => writeManifest\(\),\s*RUN_MANIFEST_HEARTBEAT_MS,?\s*\)/.test(src))
  check('heartbeat cleared in finally', /finally \{\s*(?:closeControl\?\.\(\)\s*)?clearInterval\(manifestHeartbeat\)/.test(src))
  check(
    "abort path finalizes 'paused' vs 'killed' by the LIVE status",
    /writeManifest\(\{\s*status: pausedLive \? 'paused' : 'killed',/.test(src),
  )
  check(
    "crash path never stamps a paused run 'failed' (awaited terminal write — WS3)",
    /live\?\.status === 'paused'\) \{\s*\n\s*await writeManifest\(\{ status: 'paused' \}\)/.test(src),
  )
  check("failed path finalizes with the error", /await settleRun\(\s*\{ status: terminal\.status, \.\.\.\(terminalError !== undefined \? \{ error: terminalError \} : \{\}\) \},/.test(src) && /await writeManifest\(\{\s*status: verdict\.status,\s*\.\.\.\(verdict\.error !== undefined \? \{ error: verdict\.error \} : \{\}\),/.test(src))
  check(
    'completed path finalizes with the DERIVED terminal status',
    /deriveWorkflowTerminalStatus\(\{/.test(src) && /await settleRun\(\s*\{ status: terminal\.status,/.test(src),
  )
  check('crash path finalizes too', /await settleRun\(\s*\{ status: 'failed', error: msg \},/.test(src))
  check('straggler heartbeats cannot overwrite the terminal snapshot', /if \(manifestChain\.finalized\(\)\) return/.test(src))
  check('transcriptDir joined from sessionStorage (restart-safe join)', /getWorkflowTranscriptDir\(runId\)/.test(src))
}

console.log('')
if (failures > 0) {
  console.log(`RESULT: RED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: GREEN — run manifest layer proven')
