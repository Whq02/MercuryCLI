#!/usr/bin/env bun
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}

const { formatMercuryDaemonStatus } = await import('../../src/daemon/control/status.js')

const baseStatus = (over: Record<string, unknown>): Parameters<typeof formatMercuryDaemonStatus>[0] =>
  ({
    daemon: { pid: 4242, version: '1.0.0', uptimeSec: 60, dir: process.cwd() },
    controlSock: '/tmp/mercury.sock',
    controlReachable: true,
    workersLive: 0,
    workersTotal: 0,
    breakerOpen: false,
    maxInflight: 4,
    leaseCount: 0,
    proto: 1,
    degraded: false,
    warmRunners: 1,
    fireOutcomes: null,
    handshake: null,
    versionLine: null,
    workers: [],
    ...over,
  }) as never

console.log('§1 the warm line names its workspace')
{
  const here = formatMercuryDaemonStatus(baseStatus({}))
  check(
    "in the runner's own workspace the line keeps 'here starts instantly'",
    here.includes('the next new session here starts instantly'),
    here.split('\n').find(l => l.includes('warm')) ?? '(no warm line)',
    'fix the warm line in formatMercuryDaemonStatus in src/daemon/control/status.ts: in the daemon workspace it must say the next new session here starts instantly',
  )
  const elsewhere = formatMercuryDaemonStatus(
    baseStatus({ daemon: { pid: 4242, version: '1.0.0', uptimeSec: 60, dir: '/somewhere/else' } }),
  )
  check(
    'in any other folder the line names the BOUND folder and says this one boots cold',
    elsewhere.includes('bound to /somewhere/else') &&
      elsewhere.includes('this folder boots cold') &&
      !elsewhere.includes('session here starts instantly'),
    elsewhere.split('\n').find(l => l.includes('warm')) ?? '(no warm line)',
    'fix the warm line in formatMercuryDaemonStatus in src/daemon/control/status.ts: in another folder it must name the bound folder and say this folder boots cold',
  )
  const zeroWorkers = formatMercuryDaemonStatus(baseStatus({}))
  check(
    'an idle daemon reads 0 live beside its warm line (never one process as both numbers)',
    zeroWorkers.includes('workers:      0 live / 0 rostered'),
    zeroWorkers.split('\n').find(l => l.includes('workers')) ?? '',
    'fix the workers line in formatMercuryDaemonStatus in src/daemon/control/status.ts: an idle daemon must read 0 live / 0 rostered',
  )
}

console.log('§1b every live worker names its runner pid beside its session (RELEASE-30-AIR R30A-07)')
{
  const { workerRowWords } = await import('../../src/daemon/control/status.js')
  const live = { short: 'concourse-w1', sessionId: '5e7f61a7-0000-4000-8000-000000000000', prompt: '', source: 'operator', state: 'running', pid: 99490, startedAt: 1, cliVersion: '1.0.0', model: 'claude-opus-5-5', effort: 'high' }
  const settled = { ...live, short: 'concourse-w2', sessionId: 'deadbeef-0000-4000-8000-000000000000', pid: 99500, outcome: 'completed' }
  const spawning = { ...live, short: 'concourse-w3', sessionId: 'cafe1234-0000-4000-8000-000000000000', pid: undefined, state: 'starting', model: undefined, effort: undefined }
  const text = formatMercuryDaemonStatus(baseStatus({ workersLive: 2, workersTotal: 3, workers: [live, settled, spawning] }))
  const rows = text.split('\n')
  const at = rows.findIndex(l => l.includes('workers:      2 live / 3 rostered'))
  check('the live worker reads under the workers line: its short, its runner pid, its session and its state', at >= 0 && rows[at + 1] === '    concourse-w1: pid 99490 · session 5e7f61a7 · running · claude-opus-5-5@high', rows.slice(at, at + 4).join(' | '), 'fix workerRowWords and the worker rows in formatMercuryDaemonStatus in src/daemon/control/status.ts: a live worker row must read short, pid, session, state and model@effort')
  check('a worker whose pid is not yet recorded says so', rows[at + 2] === '    concourse-w3: pid not yet recorded · session cafe1234 · starting', rows[at + 2] ?? '', 'fix workerRowWords in src/daemon/control/status.ts: a worker with no pid must read pid not yet recorded')
  check('a settled worker is not listed as live', !text.includes('concourse-w2'), text, 'fix the worker rows in formatMercuryDaemonStatus in src/daemon/control/status.ts: a worker with an outcome must not be listed as live')
  check('the words come from one owner', workerRowWords(live as never) === 'concourse-w1: pid 99490 · session 5e7f61a7 · running · claude-opus-5-5@high', '', 'fix workerRowWords in src/daemon/control/status.ts: formatMercuryDaemonStatus must build each worker row from it')
  const none = formatMercuryDaemonStatus(baseStatus({ workersLive: 0, workersTotal: 0, workers: [] }))
  check('no worker rows under an idle daemon', !/^\s{4}concourse-/m.test(none), '', 'fix the worker rows in formatMercuryDaemonStatus in src/daemon/control/status.ts: an idle daemon must list no worker rows')
}


console.log(failures === 0 ? '\nprove-status-honesty: all green' : `\nprove-status-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
