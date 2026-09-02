#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-daemon-supervisor-view.ts
//  PROOF: the /daemon cockpit reads the LIVE supervisor and stays HONEST.
//  DaemonSupervisorView was a static mockup (fake "pid 4821 / orphan b_3f1" rows
//  under an OFF badge). It now derives its view-model from getMercuryDaemonStatus()
//  via the pure deriveSupervisorRows(). We assert that derive WITHOUT mounting Ink:
//    • a live supervisor + a busy + an idle worker ⇒ badge 'live', both workers with
//      model/effort/ctx/respawns/busy — and ZERO fabricated literals;
//    • degraded ⇒ the loud reason; orphan (socket dead) ⇒ 'unavailable' + the warning;
//    • no supervisor ⇒ honest-empty (badge 'off', no rows) — NEVER a fake 'live';
//    • fire-outcome rollup + recent-trend when the window is a real subset.
//  Plus: a SOURCE grep that the rewritten view carries no 'pid 4821'/'orphan b_3f1'/
//  'queue 2' fabrication literals (regression guard), and that getMercuryDaemonStatus()
//  never throws on a missing socket (supervisor:null, workers:[]).
//  Run: ~/.bun/bin/bun run scripts/substrate/prove-daemon-supervisor-view.ts
// ============================================================================

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

import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveSupervisorRows } from '../../src/utils/cockpit/daemonSupervisorRows.js'
import type { MercuryDaemonStatus } from '../../src/daemon/status.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// Minimal WireRosterEntry fixtures (derive reads short/state/model/effort/ctx/
// respawns/busy; the rest is filled to keep the shape honest).
function mkWorker(o: Partial<Record<string, unknown>>): never {
  return {
    short: 'implementer',
    sessionId: 's1',
    prompt: 'p',
    source: 'scribe',
    state: 'running',
    startedAt: 1718000000000,
    cliVersion: '1.0.0',
    ...o,
  } as never
}
function mkStatus(o: Partial<MercuryDaemonStatus>): MercuryDaemonStatus {
  return {
    supervisor: { pid: 321, version: '1.0.0', uptimeSec: 142, dir: '/tmp/d' },
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
console.log(' DaemonSupervisorView — live cockpit, honest derive')
console.log('============================================================')

section('live supervisor + a busy + an idle worker ⇒ badge live, real rows')
{
  const st = mkStatus({
    workers: [
      mkWorker({ short: 'implementer', state: 'running', model: 'claude-opus-5', effort: 'max', contextPct: 42, respawns: 1, busy: true }),
      mkWorker({ short: 'scribe', state: 'idle', model: 'claude-fable-5[1m]', effort: 'xhigh', contextPct: 7, respawns: 0, busy: false }),
    ],
  })
  const v = deriveSupervisorRows(st)
  check("badge === 'live'", v.badge === 'live', v.badge)
  check('supervisorLine carries pid/version/uptime', /pid 321 · v1\.0\.0 · up 142s/.test(v.supervisorLine ?? ''))
  check('2 worker rows', v.workers.length === 2, `${v.workers.length}`)
  check('busy worker: model/effort/ctx/busy mapped', v.workers[0]!.short === 'implementer' && v.workers[0]!.model === 'claude-opus-5' && v.workers[0]!.effort === 'max' && v.workers[0]!.ctx === '42%' && v.workers[0]!.busy === true)
  check('idle worker: busy=false, respawns 0, ctx 7%', v.workers[1]!.busy === false && v.workers[1]!.respawns === 0 && v.workers[1]!.ctx === '7%')
  check('breaker closed, leases surfaced', v.breaker === 'closed' && v.breakerOpen === false && v.leases === 2)
  check('NOT empty', v.empty === null)
}

section("missing telemetry ⇒ honest '?'/'–' placeholders, never invented")
{
  const v = deriveSupervisorRows(mkStatus({ workers: [mkWorker({ short: 'w', state: 'running' })] }))
  check("model '?' when unset", v.workers[0]!.model === '?')
  check("effort '?' when unset", v.workers[0]!.effort === '?')
  check("ctx '–' when no usage frame", v.workers[0]!.ctx === '–')
  check('respawns defaults 0', v.workers[0]!.respawns === 0)
  check('busy defaults false', v.workers[0]!.busy === false)
}

section('elapsed-on-turn + stall (busy too long ⇒ the AMBER heads-up)')
{
  const v = deriveSupervisorRows(
    mkStatus({
      workers: [
        mkWorker({ short: 'busy-ok', busy: true, turnElapsedMs: 8 * 60_000 }), // 8m — busy, not stalled
        mkWorker({ short: 'busy-stalled', busy: true, turnElapsedMs: 12 * 60_000 }), // 12m — past 10m stall
        mkWorker({ short: 'idle-w', busy: false, turnElapsedMs: 99 * 60_000 }), // idle ⇒ no elapsed even if set
        mkWorker({ short: 'busy-noclock', busy: true }), // busy but no turn clock ⇒ no elapsed
      ],
    }),
  )
  const [ok, stalled, idle, noclock] = v.workers
  check('busy 8m ⇒ elapsed "8m", NOT stalled', ok!.elapsed === '8m' && ok!.stalled === false)
  check('busy 12m ⇒ elapsed "12m", STALLED', stalled!.elapsed === '12m' && stalled!.stalled === true)
  check('idle ⇒ no elapsed, never stalled (even with a stale turn clock)', idle!.elapsed === '' && idle!.stalled === false)
  check('busy w/o turn clock ⇒ no elapsed, not stalled', noclock!.elapsed === '' && noclock!.stalled === false)
  // wire path: turnElapsedMs is an optional field on WireRosterEntry, populated busy-only in roster.list()
  const rd = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
  const proto = rd('daemon', 'protocol.ts')
  check('WireRosterEntry carries turnElapsedMs (optional)', /turnElapsedMs\?:\s*number/.test(proto))
  const roster = rd('daemon', 'roster.ts')
  check('roster.list() populates turnElapsedMs busy-only from the turn clock', /e\.busy && h\.longLived\.turnStartedAt !== undefined/.test(roster) && /e\.turnElapsedMs = Math\.max\(0, Date\.now\(\) - h\.longLived\.turnStartedAt\)/.test(roster))
}

section('degraded ⇒ the loud escalation reason')
{
  const v = deriveSupervisorRows(mkStatus({ degraded: true, degradedReason: 'Implementer exhausted respawns' }))
  check('degraded string present', v.degraded === 'Implementer exhausted respawns')
  const vNoReason = deriveSupervisorRows(mkStatus({ degraded: true }))
  check('degraded falls back to a default reason', /exhausted its respawn budget/.test(vNoReason.degraded ?? ''))
}

section('control unreachable ⇒ unavailable + orphan warning, NO live rows')
{
  const v = deriveSupervisorRows(mkStatus({ controlReachable: false, workers: [], breakerOpen: null, leaseCount: null }))
  check("badge === 'unavailable'", v.badge === 'unavailable', v.badge)
  check('orphan warning present', /control socket unreachable/.test(v.orphanWarning ?? ''))
  check('no worker rows when unreachable', v.workers.length === 0)
  check('breaker null (unknown) renders no fake state', v.breaker === null)
}

section('no supervisor ⇒ honest-empty (NEVER a fake live)')
{
  const v = deriveSupervisorRows(mkStatus({ supervisor: null }))
  check("badge === 'off'", v.badge === 'off', v.badge)
  check('empty hint points at `mercury daemon`', /run `mercury daemon`/.test(v.empty ?? ''))
  check('zero rows', v.workers.length === 0)
  check('badge is NOT live', (v.badge as string) !== 'live')
  // null (still probing) folds to the same honest-empty shape
  const vNull = deriveSupervisorRows(null)
  check('null status ⇒ empty too', vNull.badge === 'off' && vNull.workers.length === 0)
}

section('fire-outcome rollup + recent-trend (window is a real subset)')
{
  const v = deriveSupervisorRows(mkStatus({
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
  // when total <= window, no recent line (no fake trend)
  const v2 = deriveSupervisorRows(mkStatus({
    fireOutcomes: { total: 5, byOutcome: { useful: 5 }, usefulRate: 1, recentByOutcome: { useful: 5 }, recentWindow: 10 } as never,
  }))
  check('no recent line when total ≤ window', v2.recentLine === null)
}

section('anti-fabrication: the rewritten view carries NO mockup literals')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'mercury-ui', 'parity', 'DaemonSupervisorView.tsx'), 'utf-8')
  check("no fake 'pid 4821'", !src.includes('pid 4821'))
  check("no fake 'orphan b_3f1'", !src.includes('orphan b_3f1'))
  check("no fake 'queue 2'", !src.includes('queue 2'))
  check('reads the live RPC (getMercuryDaemonStatus)', src.includes('getMercuryDaemonStatus'))
  check('derives via the pure helper (deriveSupervisorRows)', src.includes('deriveSupervisorRows'))
  check('no leftover useSpecimenNav (the old fake-roster nav)', !src.includes('useSpecimenNav'))
}

section('the /daemon command is stamp-gated (byte-identical OFF)')
{
  const idx = readFileSync(join(import.meta.dir, '..', '..', 'src', 'commands', 'daemon', 'index.ts'), 'utf-8')
  check('isEnabled: MERCURY_DAEMON_UI=0 is the only off-switch (alias-read)', /isEnabled:\s*\(\)\s*=>\s*\(flagEnv\('MERCURY_DAEMON_UI'\) === '0' \? false : true\)/.test(idx))
  check('no longer the unconditional () => true', !/isEnabled:\s*\(\)\s*=>\s*true/.test(idx))
}

section('getMercuryDaemonStatus never throws on a missing socket (supervisor:null, workers:[])')
{
  const cfgDir = mkdtempSync(join(tmpdir(), 'hermes-daemon-view-'))
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
  check('supervisor === null (no daemon)', st?.supervisor === null)
  check('workers === [] (the additive field defaults honestly)', Array.isArray(st?.workers) && st?.workers.length === 0)
  // and derive folds it to honest-empty
  check('derive(real no-daemon status) ⇒ honest-empty', deriveSupervisorRows(st).empty !== null)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-SUPERVISOR-VIEW PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-SUPERVISOR-VIEW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
