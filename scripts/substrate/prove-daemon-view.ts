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
import { deriveDaemonRows } from '../../src/utils/cockpit/daemonRows.js'
import { thisMercuryCommand } from '../../src/services/privateChannel/installPath.js'
import type { MercuryDaemonStatus } from '../../src/daemon/status.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
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
  check("badge === 'live'", v.badge === 'live', v.badge)
  check('daemonLine carries pid/version/uptime', /pid 321 · v1\.0\.0 · up 142s/.test(v.daemonLine ?? ''))
  check('2 worker rows', v.workers.length === 2, `${v.workers.length}`)
  check('busy worker: model/effort/ctx/busy mapped', v.workers[0]!.short === 'scout' && v.workers[0]!.model === 'claude-opus-5' && v.workers[0]!.effort === 'max' && v.workers[0]!.ctx === '42%' && v.workers[0]!.busy === true)
  check('idle worker: busy=false, respawns 0, ctx 7%', v.workers[1]!.busy === false && v.workers[1]!.respawns === 0 && v.workers[1]!.ctx === '7%')
  check('breaker closed, leases surfaced', v.breaker === 'closed' && v.breakerOpen === false && v.leases === 2)
  check('NOT empty', v.empty === null)
}

section("missing telemetry ⇒ honest '?'/'–' placeholders, never invented")
{
  const v = deriveDaemonRows(mkStatus({ workers: [mkWorker({ short: 'w', state: 'running' })] }))
  check("model '?' when unset", v.workers[0]!.model === '?')
  check("effort '?' when unset", v.workers[0]!.effort === '?')
  check("ctx '–' when no usage frame", v.workers[0]!.ctx === '–')
  check('respawns defaults 0', v.workers[0]!.respawns === 0)
  check('busy defaults false', v.workers[0]!.busy === false)
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
  check('busy 8m ⇒ elapsed "8m", NOT stalled', ok!.elapsed === '8m' && ok!.stalled === false)
  check('busy 12m ⇒ elapsed "12m", STALLED', stalled!.elapsed === '12m' && stalled!.stalled === true)
  check('idle ⇒ no elapsed, never stalled (even with a stale turn clock)', idle!.elapsed === '' && idle!.stalled === false)
  check('busy w/o turn clock ⇒ no elapsed, not stalled', noclock!.elapsed === '' && noclock!.stalled === false)
}

section('degraded ⇒ the loud escalation reason')
{
  const v = deriveDaemonRows(mkStatus({ degraded: true, degradedReason: 'scout exhausted respawns' }))
  check('degraded string present', v.degraded === 'scout exhausted respawns')
  const vNoReason = deriveDaemonRows(mkStatus({ degraded: true }))
  check('degraded falls back to a default reason', /exhausted its respawn budget/.test(vNoReason.degraded ?? ''))
}

section('control unreachable ⇒ unavailable + orphan warning, NO live rows')
{
  const v = deriveDaemonRows(mkStatus({ controlReachable: false, workers: [], breakerOpen: null, leaseCount: null }))
  check("badge === 'unavailable'", v.badge === 'unavailable', v.badge)
  check('orphan warning present', /control socket unreachable/.test(v.orphanWarning ?? ''))
  check('no worker rows when unreachable', v.workers.length === 0)
  check('breaker null (unknown) renders no fake state', v.breaker === null)
}

section('no daemon ⇒ honest-empty (NEVER a fake live)')
{
  const v = deriveDaemonRows(mkStatus({ daemon: null }))
  check("badge === 'off'", v.badge === 'off', v.badge)
  check("empty hint points at this install's own `… daemon` start", (v.empty ?? '').startsWith(`run \`${thisMercuryCommand()} daemon\``), v.empty ?? '')
  check('zero rows', v.workers.length === 0)
  check('badge is NOT live', (v.badge as string) !== 'live')
  const vNull = deriveDaemonRows(null)
  check('null status ⇒ empty too', vNull.badge === 'off' && vNull.workers.length === 0)
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
  check('fireLine has total + useful-rate + last', /fires 30 · useful-rate 60% · last useful/.test(v.fireLine ?? ''))
  check('recentLine present (total>window)', /recent 10:/.test(v.recentLine ?? ''))
  const v2 = deriveDaemonRows(mkStatus({
    fireOutcomes: { total: 5, byOutcome: { useful: 5 }, usefulRate: 1, recentByOutcome: { useful: 5 }, recentWindow: 10 } as never,
  }))
  check('no recent line when total ≤ window', v2.recentLine === null)
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
  check('did not throw', !threw)
  check('daemon === null (no daemon)', st?.daemon === null)
  check('workers === [] (the additive field defaults honestly)', Array.isArray(st?.workers) && st?.workers.length === 0)
  check('derive(real no-daemon status) ⇒ honest-empty', deriveDaemonRows(st).empty !== null)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-VIEW PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-VIEW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
