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
import { deriveDaemonRows } from '../../src/screen/cockpit-gauges/daemonRows.js'
import { thisMercuryCommand } from '../../src/platform/update-channel/installPath.js'
import type { MercuryDaemonStatus } from '../../src/daemon/control/status.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
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
  check("badge === 'live'", v.badge === 'live', v.badge, 'fix the badge in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a record with a reachable control socket must give live')
  check('daemonLine carries pid/version/uptime', /pid 321 · v1\.0\.0 · up 142s/.test(v.daemonLine ?? ''), '', 'fix daemonLine in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it must read pid N · vVERSION · up Ns from status.daemon; it was ' + (v.daemonLine ?? 'null'))
  check('2 worker rows', v.workers.length === 2, `${v.workers.length}`, 'fix the workers mapping in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): one row per entry of status.workers')
  check('busy worker: model/effort/ctx/busy mapped', v.workers[0]!.short === 'scout' && v.workers[0]!.model === 'claude-opus-5' && v.workers[0]!.effort === 'max' && v.workers[0]!.ctx === '42%' && v.workers[0]!.busy === true, '', 'fix the row mapping in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): short, model, effort, ctx as contextPct with a percent sign, and busy must copy from the worker')
  check('idle worker: busy=false, respawns 0, ctx 7%', v.workers[1]!.busy === false && v.workers[1]!.respawns === 0 && v.workers[1]!.ctx === '7%', '', 'fix the row mapping in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): an idle worker must give busy false, respawns 0 and ctx 7%')
  check('breaker closed, leases surfaced', v.breaker === 'closed' && v.breakerOpen === false && v.leases === 2, '', 'fix breaker, breakerOpen and leases in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): closed breaker reads closed, leases copies status.leaseCount')
  check('NOT empty', v.empty === null, '', 'deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts) must leave empty null whenever status.daemon is present')
}

section("missing telemetry ⇒ honest '?'/'–' placeholders, never invented")
{
  const v = deriveDaemonRows(mkStatus({ workers: [mkWorker({ short: 'w', state: 'running' })] }))
  check("model '?' when unset", v.workers[0]!.model === '?', '', 'fix the model default in the workers mapping of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a missing model must read ?')
  check("effort '?' when unset", v.workers[0]!.effort === '?', '', 'fix the effort default in the workers mapping of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a missing effort must read ?')
  check("ctx '–' when no usage frame", v.workers[0]!.ctx === '–', '', 'fix the ctx default in the workers mapping of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a missing contextPct must read the en dash, never 0%')
  check('respawns defaults 0', v.workers[0]!.respawns === 0, '', 'fix the respawns default in the workers mapping of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a missing count must be 0')
  check('busy defaults false', v.workers[0]!.busy === false, '', 'fix busy in the workers mapping of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it is true only when the worker busy flag is exactly true')
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
  check('busy 8m ⇒ elapsed "8m", NOT stalled', ok!.elapsed === '8m' && ok!.stalled === false, '', 'fix elapsed and stalled in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a busy worker at 8 minutes reads 8m and is stalled only past half of getMaxTurnMs')
  check('busy 12m ⇒ elapsed "12m", STALLED', stalled!.elapsed === '12m' && stalled!.stalled === true, '', 'fix elapsed and stalled in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a busy worker at 12 minutes reads 12m and is stalled once past stallMs, half of getMaxTurnMs')
  check('idle ⇒ no elapsed, never stalled (even with a stale turn clock)', idle!.elapsed === '' && idle!.stalled === false, '', 'fix elapsed and stalled in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): both depend on busy being true, so an idle worker has an empty elapsed and is never stalled')
  check('busy w/o turn clock ⇒ no elapsed, not stalled', noclock!.elapsed === '' && noclock!.stalled === false, '', 'fix elapsed and stalled in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): without turnElapsedMs the elapsed text is empty and stalled is false')
}

section('degraded ⇒ the loud escalation reason')
{
  const v = deriveDaemonRows(mkStatus({ degraded: true, degradedReason: 'scout exhausted respawns' }))
  check('degraded string present', v.degraded === 'scout exhausted respawns', '', 'fix degraded in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): when status.degraded is true it must return status.degradedReason')
  const vNoReason = deriveDaemonRows(mkStatus({ degraded: true }))
  check('degraded falls back to a default reason', /exhausted its respawn budget/.test(vNoReason.degraded ?? ''), '', 'fix the fallback text of degraded in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): with no degradedReason it must say a long-lived worker exhausted its respawn budget')
}

section('control unreachable ⇒ unavailable + orphan warning, NO live rows')
{
  const v = deriveDaemonRows(mkStatus({ controlReachable: false, workers: [], breakerOpen: null, leaseCount: null }))
  check("badge === 'unavailable'", v.badge === 'unavailable', v.badge, 'fix the badge in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a daemon record with controlReachable false must give unavailable')
  check('orphan warning present', /control socket unreachable/.test(v.orphanWarning ?? ''), '', 'fix orphanWarning in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): with controlReachable false it must say control socket unreachable')
  check('no worker rows when unreachable', v.workers.length === 0, '', 'the test passes an empty workers list, so the rows deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts) returns must come only from status.workers')
  check('breaker null (unknown) renders no fake state', v.breaker === null, '', 'fix breaker in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a null breakerOpen must give a null breaker')
}

section('no daemon ⇒ honest-empty (NEVER a fake live)')
{
  const v = deriveDaemonRows(mkStatus({ daemon: null }))
  check("badge === 'off'", v.badge === 'off', v.badge, 'fix the first branch of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): status.daemon null must give badge off')
  check("empty hint points at this install's own `… daemon` start", (v.empty ?? '').startsWith(`run \`${thisMercuryCommand()} daemon\``), v.empty ?? '', 'fix empty in the no-daemon branch of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it must start with run, then the command from thisMercuryCommand and daemon in backticks')
  check('zero rows', v.workers.length === 0, '', 'fix the no-daemon branch of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it must return an empty workers list')
  check('badge is NOT live', (v.badge as string) !== 'live', '', 'fix the no-daemon branch of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it must never return live')
  const vNull = deriveDaemonRows(null)
  check('null status ⇒ empty too', vNull.badge === 'off' && vNull.workers.length === 0, '', 'fix the first branch of deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): a null status must give badge off and no workers')
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
  check('fireLine has total + useful-rate + last', /fires 30 · useful-rate 60% · last useful/.test(v.fireLine ?? ''), '', 'fix fireLine in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it must read fires TOTAL · useful-rate N% · last OUTCOME; it was ' + (v.fireLine ?? 'null'))
  check('recentLine present (total>window)', /recent 10:/.test(v.recentLine ?? ''), '', 'fix recentLine in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): when total exceeds recentWindow it must read recent WINDOW: followed by the outcome counts; it was ' + (v.recentLine ?? 'null'))
  const v2 = deriveDaemonRows(mkStatus({
    fireOutcomes: { total: 5, byOutcome: { useful: 5 }, usefulRate: 1, recentByOutcome: { useful: 5 }, recentWindow: 10 } as never,
  }))
  check('no recent line when total ≤ window', v2.recentLine === null, '', 'fix recentLine in deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts): it must stay null unless total exceeds recentWindow')
}


section('getMercuryDaemonStatus never throws on a missing socket (daemon:null, workers:[])')
{
  const cfgDir = mkdtempSync(join(tmpdir(), 'mercury-daemon-view-'))
  process.env.MERCURY_CONFIG_DIR = cfgDir
  const { getMercuryDaemonStatus } = await import('../../src/daemon/control/status.js')
  let threw = false
  let st: MercuryDaemonStatus | null = null
  try {
    st = await getMercuryDaemonStatus()
  } catch {
    threw = true
  }
  check('did not throw', !threw, '', 'getMercuryDaemonStatus in src/daemon/control/status.ts must return a status with daemon null when no state file or socket exists, never throw')
  check('daemon === null (no daemon)', st?.daemon === null, '', 'fix getMercuryDaemonStatus in src/daemon/control/status.ts: with no daemon state file under the scratch config dir, daemon must be null')
  check('workers === [] (the additive field defaults honestly)', Array.isArray(st?.workers) && st?.workers.length === 0, '', 'fix getMercuryDaemonStatus in src/daemon/control/status.ts: with no daemon the snapshot workers field must be an empty array')
  check('derive(real no-daemon status) ⇒ honest-empty', deriveDaemonRows(st).empty !== null, '', 'deriveDaemonRows (src/screen/cockpit-gauges/daemonRows.ts) must set empty for the status getMercuryDaemonStatus (src/daemon/control/status.ts) returns when no daemon runs')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-VIEW PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-VIEW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
