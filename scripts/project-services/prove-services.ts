#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-services.ts — named project
//  services, proved with REAL child processes (node fixtures) through the
//  PRODUCTION manager + tool: readiness combinations, cursored logs, stdin,
//  restart (auto + explicit), explicit-stop suppression, and pid/start-token
//  reconciliation (the Mercury-restart story: records on disk, truth from
//  the process table).
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-services.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-svc-'))
delete process.env.MERCURY_SERVICES

const {
  evaluateReadiness,
  readLogs,
  readRecord,
  reconcileRecord,
  restartService,
  sendInput,
  startService,
  stopService,
  waitForReady,
} = await import('../../src/services/projectServices/serviceManager.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — services proof exceeded 150s')
  process.exit(1)
}, 150_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'vanguard-svc-work-'))
const NODE = process.execPath
const PORT = 47000 + (process.pid % 900)
const SESSION = 'svc-proof-session'

const HTTP_FIXTURE = `
const http = require('http');
const s = http.createServer((req, res) => { res.statusCode = 200; res.end('hello vanguard'); });
s.listen(${PORT}, () => console.log('listening on ${PORT}'));
process.stdin.on('data', d => console.log('echo:', String(d).trim()));
`

// ── H. the full happy journey ───────────────────────────────────────────────
section('H. start → combined readiness → cursored logs → input → restart → stop')
{
  const started = await startService({
    sessionId: SESSION,
    spec: {
      name: 'web',
      command: NODE,
      args: ['-e', HTTP_FIXTURE],
      cwd: workDir,
      readiness: [
        { kind: 'log', regex: `listening on ${PORT}` },
        { kind: 'http', url: `http://127.0.0.1:${PORT}/`, status: 200, bodyRegex: 'hello vanguard' },
        { kind: 'tcp', port: PORT },
      ],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  check('H1 start records starting + pid + start token',
    'record' in started && started.record.state === 'starting' &&
    started.record.pid !== null && started.record.startToken !== null)

  const wait = await waitForReady(workDir, 'web', 15_000)
  check('H2 wait meets ALL THREE conditions (log + http + tcp)',
    wait.ready && wait.record?.state === 'ready' &&
    wait.statuses.length === 3 && wait.statuses.every(s => s.met),
    JSON.stringify(wait.statuses.map(s => s.detail)))

  const logs1 = await readLogs(workDir, 'web', {})
  check('H3 the tail read shows the boot line',
    !('error' in logs1) && logs1.lines.some(l => l.includes(`listening on ${PORT}`)))
  const cursor = 'error' in logs1 ? 0 : logs1.nextCursor

  const sent = sendInput(workDir, 'web', 'ping-from-proof', SESSION)
  check('H4 stdin input reaches the spawning-session child', 'ok' in sent)
  await new Promise(r => setTimeout(r, 400))
  const logs2 = await readLogs(workDir, 'web', { cursor })
  check('H5 the cursor read returns STRICTLY newer lines (the echo, not the boot line)',
    !('error' in logs2) &&
    logs2.lines.some(l => l.includes('echo: ping-from-proof')) &&
    !logs2.lines.some(l => l.includes('listening on')),
    JSON.stringify(logs2))

  const firstPid = readRecord(workDir, 'web')?.pid
  const restarted = await restartService(workDir, 'web', SESSION)
  check('H6 restart reuses the retained spec with a NEW pid + bumped count',
    'record' in restarted &&
    restarted.record.pid !== null &&
    restarted.record.pid !== firstPid &&
    restarted.record.restartCount === 1)
  const reWait = await waitForReady(workDir, 'web', 15_000)
  check('H7 the restarted service becomes ready again', reWait.ready)

  const stopped = await stopService(workDir, 'web')
  check('H8 explicit stop lands as stopped (restart suppressed)',
    'record' in stopped && stopped.record.state === 'stopped' && stopped.record.explicitStop)
  const after = reconcileRecord(workDir, 'web')
  check('H9 reconciliation confirms nothing is alive', after?.state === 'stopped' && after.pid === null)
}

// ── F. exit before readiness ────────────────────────────────────────────────
section('F. a process that dies before readiness')
{
  const started = await startService({
    sessionId: SESSION,
    spec: {
      name: 'doomed',
      command: NODE,
      args: ['-e', "console.error('boom: missing config'); process.exit(3)"],
      cwd: workDir,
      readiness: [{ kind: 'log', regex: 'never-appears' }],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  check('F1 start accepted', 'record' in started)
  const wait = await waitForReady(workDir, 'doomed', 5_000)
  check('F2 wait reports FAILED with the unmet condition named',
    !wait.ready && wait.record?.state === 'failed' &&
    wait.statuses.some(s => !s.met && s.detail.includes('never-appears')))
  check('F3 the exit code is recorded', wait.record?.lastExitCode === 3)
  const logs = await readLogs(workDir, 'doomed', {})
  check('F4 the logs show WHY (stderr shares the ordered log)',
    !('error' in logs) && logs.lines.some(l => l.includes('boom: missing config')))
}

// ── U. a condition that never satisfies ─────────────────────────────────────
section('U. unmet-condition honesty on a LIVE process')
{
  await startService({
    sessionId: SESSION,
    spec: {
      name: 'stuck',
      command: NODE,
      args: ['-e', 'console.log("up"); setInterval(() => {}, 1000)'],
      cwd: workDir,
      readiness: [
        { kind: 'log', regex: 'up' },
        { kind: 'file', path: join(workDir, 'never-created.flag') },
      ],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  const wait = await waitForReady(workDir, 'stuck', 2_000)
  check('U1 the timeout names EXACTLY the unmet condition (met one stays met)',
    !wait.ready &&
    wait.statuses.filter(s => !s.met).length === 1 &&
    wait.statuses.find(s => !s.met)?.detail.includes('never-created.flag') === true &&
    wait.statuses.find(s => s.met)?.detail.includes('/up/') === true,
    JSON.stringify(wait.statuses))
  check('U2 the process stays starting (alive, not failed)', wait.record?.state === 'starting')
  const anyMode = await evaluateReadiness(workDir, { ...wait.record!, spec: { ...wait.record!.spec, readinessMode: 'any' } })
  check('U3 readinessMode any would pass with the same statuses', anyMode.ready)
  await stopService(workDir, 'stuck')
}

// ── R. on-failure restart with bounded backoff ──────────────────────────────
section('R. auto-restart on failure; explicit stop suppresses')
{
  await startService({
    sessionId: SESSION,
    spec: {
      name: 'flappy',
      command: NODE,
      args: ['-e', "console.log('ran once'); process.exit(1)"],
      cwd: workDir,
      readiness: [],
      readinessMode: 'all',
      restart: 'on-failure',
      lifecycle: 'session',
    },
  })
  await new Promise(r => setTimeout(r, 1_800))
  const record = readRecord(workDir, 'flappy')
  check('R1 the failure auto-restarted at least once (bounded backoff)',
    (record?.restartCount ?? 0) >= 1, JSON.stringify({ count: record?.restartCount, state: record?.state }))
  const stopped = await stopService(workDir, 'flappy')
  check('R2 explicit stop marks stopped', 'record' in stopped && stopped.record.state === 'stopped')
  const countAtStop = readRecord(workDir, 'flappy')?.restartCount ?? -1
  await new Promise(r => setTimeout(r, 1_500))
  const later = readRecord(workDir, 'flappy')
  check('R3 no restart fires after the explicit stop',
    later?.restartCount === countAtStop && later?.state === 'stopped')
}

// ── C. reconciliation (the Mercury-restart story) ───────────────────────────
section('C. records never claim a live process')
{
  const started = await startService({
    sessionId: SESSION,
    spec: {
      name: 'orphan',
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: workDir,
      readiness: [],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  const pid = 'record' in started ? started.record.pid : null
  check('C1 live process reconciles as live', reconcileRecord(workDir, 'orphan')?.state === 'starting')
  // Kill it EXTERNALLY (as if Mercury restarted and the process died) —
  // the exit handler will also fire in-process; reconciliation must agree.
  if (pid) process.kill(pid, 'SIGKILL')
  await new Promise(r => setTimeout(r, 500))
  const reconciled = reconcileRecord(workDir, 'orphan')
  check('C2 a dead pid reconciles to failed (never live from a record)',
    reconciled?.state === 'failed' && reconciled.pid === null)
}

// ── T. the tool surface ─────────────────────────────────────────────────────
section('T. the Service tool end-to-end')
{
  const { ServiceTool } = await import('../../src/tools/ServiceTool/ServiceTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionId: SESSION,
    }),
    setAppState: () => {},
    options: { tools: [], isNonInteractiveSession: true },
  }
  const call = (input: Record<string, unknown>) =>
    (ServiceTool as { call: Function }).call(input, ctx)

  // getCwd() is the proof process cwd — pass cwd explicitly on every op.
  const t1 = await call({
    op: 'start',
    name: 'tool-web',
    command: NODE,
    args: ['-e', "console.log('tool web up'); setInterval(() => {}, 1000)"],
    cwd: workDir,
    readiness: [{ kind: 'log', regex: 'tool web up' }],
  })
  check('T1 tool start succeeds with the ref line',
    t1.effect.outcome === 'succeeded' && t1.data.result.includes('mercury://service/tool-web'))
  const t2 = await call({ op: 'wait', name: 'tool-web', cwd: workDir, timeoutMs: 10_000 })
  check('T2 tool wait reaches READY', t2.data.result.includes('READY'))
  const t3 = await call({ op: 'logs', name: 'tool-web', cwd: workDir })
  check('T3 tool logs carry the cursor line', /\[cursor: \d+/.test(t3.data.result))
  const t4 = await call({ op: 'list', cwd: workDir })
  check('T4 list shows reconciled truth', t4.data.result.includes('tool-web — ready'))
  const t5 = await call({ op: 'stop', name: 'tool-web', cwd: workDir })
  check('T5 tool stop succeeds', t5.effect.outcome === 'succeeded' && t5.data.state === 'stopped')
  const t6 = await call({ op: 'describe', name: 'no-such-service', cwd: workDir })
  check('T6 an unknown service reads honest-absent (no-change effect)',
    t6.effect.outcome === 'no-change' && t6.data.result.includes("no service 'no-such-service'"))

  // The resource adapter (registered by the slice) resolves the service.
  const { resolveResource } = await import('../../src/services/resources/registry.ts')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
  const owner = makeOwnerKey({ workspace: workDir, sessionId: SESSION, lane: 'main' } as never)
  const ref = await resolveResource('mercury://service/tool-web', { owner, cwd: workDir } as never)
  check('T7 mercury://service/<name> resolves through the ONE resolver',
    ref.state === 'ok' && ref.resource.summary.includes('stopped'))
  const refLogs = await resolveResource('mercury://service/tool-web?child=logs', { owner, cwd: workDir } as never)
  check('T8 the logs child serves the cursored view',
    refLogs.state === 'ok' && refLogs.resource.text?.includes('tool web up') === true)
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ services: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ services: every law holds')
process.exit(0)
