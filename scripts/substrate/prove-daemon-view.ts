#!/usr/bin/env bun

import { plugin } from 'bun'
plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveDaemonRows } from '../../src/services/cockpit/daemonRows.js'
import { thisMercuryCommand } from '../../src/services/privateChannel/installPath.js'
import type { MercuryDaemonStatus } from '../../src/daemon/status.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = !cond && hint ? (detail ? detail + ' — ' : '') + hint : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
}
const rowsFn = 'deriveDaemonRows in src/services/cockpit/daemonRows.ts'
const statusFn = 'getMercuryDaemonStatus in src/daemon/status.ts'
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function mkWorker(o: Partial<Record<string, unknown>>): never {
  return {
    short: 'scout',
    sessionId: 's1',
    prompt: 'p',
    source: 'crew',
    state: 'running',
    startedAt: 1718000000000,
    cliVersion: '1.0.0',
    ...o,
  } as never
}
function mkStatus(o: Partial<MercuryDaemonStatus>): MercuryDaemonStatus {
  return {
    daemon: { pid: 321, version: '1.0.0', uptimeSec: 142, dir: '/tmp/d' },
    controlSock: '/tmp/d/control.sock',
    controlReachable: true,
    workersLive: 1,
    workersTotal: 1,
    breakerOpen: false,
    maxInflight: 4,
    leaseCount: 2,
    proto: 4,
    degraded: false,
    fireOutcomes: null,
    handshake: null,
    versionLine: null,
    workers: [],
    ...o,
  }
}

console.log('============================================================')
console.log(' DaemonView — live cockpit, honest derive')
console.log('============================================================')

section('live daemon + a busy + an idle worker ⇒ badge live, real rows')
{
  const st = mkStatus({
    workers: [
      mkWorker({ short: 'scout', state: 'running', model: 'claude-opus-5', effort: 'max', contextPct: 42, respawns: 1, busy: true }),
      mkWorker({ short: 'runner', state: 'idle', model: 'claude-fable-5[1m]', effort: 'xhigh', contextPct: 7, respawns: 0, busy: false }),
    ],
  })
  const v = deriveDaemonRows(st)
  check("badge === 'live'", v.badge === 'live', v.badge, rowsFn + ' must give badge live for a status with a daemon and a reachable control socket')
  check('daemonLine carries pid/version/uptime', /pid 321 · v1\.0\.0 · up 142s/.test(v.daemonLine ?? ''), v.daemonLine ?? '', rowsFn + ' must build daemonLine as pid N · vVERSION · up Ns from status.daemon')
  check('2 worker rows', v.workers.length === 2, `${v.workers.length}`, rowsFn + ' must map each status.workers entry to one row')
  check('busy worker: model/effort/ctx/busy mapped', v.workers[0]!.short === 'scout' && v.workers[0]!.model === 'claude-opus-5' && v.workers[0]!.effort === 'max' && v.workers[0]!.ctx === '42%' && v.workers[0]!.busy === true, JSON.stringify(v.workers[0]), rowsFn + ' must map short, model, effort, contextPct as N% and busy onto the row')
  check('idle worker: busy=false, respawns 0, ctx 7%', v.workers[1]!.busy === false && v.workers[1]!.respawns === 0 && v.workers[1]!.ctx === '7%', JSON.stringify(v.workers[1]), rowsFn + ' must map busy false, respawns and contextPct as N% for an idle worker')
  check('breaker closed, leases surfaced', v.breaker === 'closed' && v.breakerOpen === false && v.leases === 2, JSON.stringify({ breaker: v.breaker, breakerOpen: v.breakerOpen, leases: v.leases }), rowsFn + ' must map breakerOpen to breaker closed or open and leaseCount to leases')
  check('NOT empty', v.empty === null, String(v.empty), rowsFn + ' must leave empty null when a daemon is present')
}

section("missing telemetry ⇒ honest '?'/'–' placeholders, never invented")
{
  const v = deriveDaemonRows(mkStatus({ workers: [mkWorker({ short: 'w', state: 'running' })] }))
  check("model '?' when unset", v.workers[0]!.model === '?', v.workers[0]!.model, rowsFn + ' must show ? for a worker with no model')
  check("effort '?' when unset", v.workers[0]!.effort === '?', v.workers[0]!.effort, rowsFn + ' must show ? for a worker with no effort')
  check("ctx '–' when no usage frame", v.workers[0]!.ctx === '–', v.workers[0]!.ctx, rowsFn + ' must show – for a worker with no contextPct')
  check('respawns defaults 0', v.workers[0]!.respawns === 0, String(v.workers[0]!.respawns), rowsFn + ' must default respawns to 0')
  check('busy defaults false', v.workers[0]!.busy === false, String(v.workers[0]!.busy), rowsFn + ' must default busy to false')
}

section('elapsed-on-turn + stall (busy too long ⇒ the AMBER heads-up)')
{
  const v = deriveDaemonRows(
    mkStatus({
      workers: [
        mkWorker({ short: 'busy-ok', busy: true, turnElapsedMs: 8 * 60_000 }),
        mkWorker({ short: 'busy-stalled', busy: true, turnElapsedMs: 12 * 60_000 }),
        mkWorker({ short: 'idle-w', busy: false, turnElapsedMs: 99 * 60_000 }),
        mkWorker({ short: 'busy-noclock', busy: true }),
      ],
    }),
  )
  const [ok, stalled, idle, noclock] = v.workers
  check('busy 8m ⇒ elapsed "8m", NOT stalled', ok!.elapsed === '8m' && ok!.stalled === false, JSON.stringify(ok), rowsFn + ' must format turnElapsedMs as minutes and set stalled only past its stall threshold')
  check('busy 12m ⇒ elapsed "12m", STALLED', stalled!.elapsed === '12m' && stalled!.stalled === true, JSON.stringify(stalled), rowsFn + ' must set stalled for a busy worker past its stall threshold (12m here)')
  check('idle ⇒ no elapsed, never stalled (even with a stale turn clock)', idle!.elapsed === '' && idle!.stalled === false, JSON.stringify(idle), rowsFn + ' must give an idle worker no elapsed and never stalled')
  check('busy w/o turn clock ⇒ no elapsed, not stalled', noclock!.elapsed === '' && noclock!.stalled === false, JSON.stringify(noclock), rowsFn + ' must give a busy worker with no turnElapsedMs no elapsed and not stalled')
}

section('degraded ⇒ the loud escalation reason')
{
  const v = deriveDaemonRows(mkStatus({ degraded: true, degradedReason: 'scout exhausted respawns' }))
  check('degraded string present', v.degraded === 'scout exhausted respawns', String(v.degraded), rowsFn + ' must pass degradedReason through as degraded')
  const vNoReason = deriveDaemonRows(mkStatus({ degraded: true }))
  check('degraded falls back to a default reason', /exhausted its respawn budget/.test(vNoReason.degraded ?? ''), String(vNoReason.degraded), rowsFn + ' must use a default reason naming the exhausted respawn budget when degraded has no degradedReason')
}

section('control unreachable ⇒ unavailable + orphan warning, NO live rows')
{
  const v = deriveDaemonRows(mkStatus({ controlReachable: false, workers: [], breakerOpen: null, leaseCount: null }))
  check("badge === 'unavailable'", v.badge === 'unavailable', v.badge, rowsFn + ' must give badge unavailable when controlReachable is false')
  check('orphan warning present', /control socket unreachable/.test(v.orphanWarning ?? ''), String(v.orphanWarning), rowsFn + ' must set orphanWarning naming the unreachable control socket')
  check('no worker rows when unreachable', v.workers.length === 0, `${v.workers.length}`, rowsFn + ' must return no worker rows when the control socket is unreachable')
  check('breaker null (unknown) renders no fake state', v.breaker === null, String(v.breaker), rowsFn + ' must leave breaker null when breakerOpen is null')
}

section('no daemon ⇒ honest-empty (NEVER a fake live)')
{
  const v = deriveDaemonRows(mkStatus({ daemon: null }))
  check("badge === 'off'", v.badge === 'off', v.badge, rowsFn + ' must give badge off when status.daemon is null')
  check("empty hint points at this install's own `… daemon` start", (v.empty ?? '').startsWith(`run \`${thisMercuryCommand()} daemon\``), v.empty ?? '', 'the empty text of ' + rowsFn + ' must start with run followed by thisMercuryCommand() and daemon')
  check('zero rows', v.workers.length === 0, `${v.workers.length}`, rowsFn + ' must return no worker rows when status.daemon is null')
  check('badge is NOT live', (v.badge as string) !== 'live', v.badge, rowsFn + ' must never give badge live without a daemon')
  const vNull = deriveDaemonRows(null)
  check('null status ⇒ empty too', vNull.badge === 'off' && vNull.workers.length === 0, vNull.badge, rowsFn + ' must treat a null status as no daemon')
}

section('fire-outcome rollup + recent-trend (window is a real subset)')
{
  const v = deriveDaemonRows(mkStatus({
    fireOutcomes: {
      total: 30,
      byOutcome: { useful: 18, no_op: 9, failed: 3 },
      last: { outcome: 'useful' } as never,
      usefulRate: 0.6,
      recentByOutcome: { useful: 6, no_op: 3, failed: 1 },
      recentWindow: 10,
    } as never,
  }))
  check('fireLine has total + useful-rate + last', /fires 30 · useful-rate 60% · last useful/.test(v.fireLine ?? ''), v.fireLine ?? '', rowsFn + ' must build fireLine from fireOutcomes total, usefulRate as a percent and last outcome')
  check('recentLine present (total>window)', /recent 10:/.test(v.recentLine ?? ''), String(v.recentLine), rowsFn + ' must build recentLine when total exceeds recentWindow')
  const v2 = deriveDaemonRows(mkStatus({
    fireOutcomes: { total: 5, byOutcome: { useful: 5 }, usefulRate: 1, recentByOutcome: { useful: 5 }, recentWindow: 10 } as never,
  }))
  check('no recent line when total ≤ window', v2.recentLine === null, String(v2.recentLine), rowsFn + ' must leave recentLine null when total is at most recentWindow')
}


section('getMercuryDaemonStatus never throws on a missing socket (daemon:null, workers:[])')
{
  const cfgDir = mkdtempSync(join(tmpdir(), 'mercury-daemon-view-'))
  process.env.MERCURY_CONFIG_DIR = cfgDir
  const { getMercuryDaemonStatus } = await import('../../src/daemon/status.js')
  let threw = false
  let st: MercuryDaemonStatus | null = null
  try {
    st = await getMercuryDaemonStatus()
  } catch {
    threw = true
  }
  check('did not throw', !threw, '', statusFn + ' must catch a missing control socket and return a status')
  check('daemon === null (no daemon)', st?.daemon === null, JSON.stringify(st?.daemon), statusFn + ' must return daemon null when no daemon record exists')
  check('workers === [] (the additive field defaults honestly)', Array.isArray(st?.workers) && st?.workers.length === 0, JSON.stringify(st?.workers), statusFn + ' must default workers to an empty array')
  check('derive(real no-daemon status) ⇒ honest-empty', deriveDaemonRows(st).empty !== null, '', rowsFn + ' must set empty for the status ' + statusFn + ' returns with no daemon')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-VIEW PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-VIEW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
