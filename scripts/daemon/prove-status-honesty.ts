#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-status-honesty.ts — daemon status speaks workspace
//  truth (FC-086) and counts each process once (FC-087).
//
//  FC-086: the warm line said "the next new session HERE starts instantly"
//  in every working folder, but the pool is workspace-bound and a claim
//  from any other folder is refused — the report's own dir: row named the
//  bound folder two lines above the promise.
//  FC-087: the daemon counted the unclaimed warm runner as a live worker
//  AND named it on its own line — an idle daemon read `workers: 1 live /
//  2 rostered`, one process wearing both numbers.
//
//  §1 the warm line, rendered pure (formatMercuryDaemonStatus fixtures).
//  §2 the counting seam excludes the warm pool (call-shaped).
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-status-honesty.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

const { formatMercuryDaemonStatus } = await import('../../src/daemon/status.js')

const baseStatus = (over: Record<string, unknown>): Parameters<typeof formatMercuryDaemonStatus>[0] =>
  ({
    supervisor: { pid: 4242, version: '1.0.0', uptimeSec: 60, dir: process.cwd() },
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
  )
  const elsewhere = formatMercuryDaemonStatus(
    baseStatus({ supervisor: { pid: 4242, version: '1.0.0', uptimeSec: 60, dir: '/somewhere/else' } }),
  )
  check(
    'in any other folder the line names the BOUND folder and says this one boots cold',
    elsewhere.includes('bound to /somewhere/else') &&
      elsewhere.includes('this folder boots cold') &&
      !elsewhere.includes('session here starts instantly'),
    elsewhere.split('\n').find(l => l.includes('warm')) ?? '(no warm line)',
  )
  const zeroWorkers = formatMercuryDaemonStatus(baseStatus({}))
  check(
    'an idle daemon reads 0 live beside its warm line (never one process as both numbers)',
    zeroWorkers.includes('workers:      0 live / 0 rostered'),
    zeroWorkers.split('\n').find(l => l.includes('workers')) ?? '',
  )
}

console.log('§2 the counting seam excludes the warm pool (call-shaped)')
{
  const server = readFileSync(join(ROOT, 'src', 'daemon', 'controlServer.ts'), 'utf8')
  check(
    'workersLive subtracts the warm pool at the status reply',
    /workersLive: Math\.max\(\s*\n?\s*0,\s*\n?\s*deps\.roster\.liveCount\(\) - \(deps\.warmRunnerCount/.test(server),
  )
  check(
    'workersTotal does too',
    /workersTotal: Math\.max\(\s*\n?\s*0,\s*\n?\s*deps\.roster\.totalCount\(\) - \(deps\.warmRunnerCount/.test(server),
  )
}

console.log(failures === 0 ? '\nprove-status-honesty: all green' : `\nprove-status-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
