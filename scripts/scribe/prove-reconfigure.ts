#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-reconfigure.ts
//  W2 — per-agent targeting: the daemon `reconfigure` control RPC + the pure
//  respawn-if-idle-else-queue decision.
//
//   (a) workerIsIdle: undefined lastDeliveredAt ⇒ idle (nothing delivered / bus
//       opted out); a recent delivery ⇒ busy; a stale delivery (> idleMs) ⇒ idle.
//   (b) decideReconfigure: idle ⇒ {respawn:true,pending:false};
//       busy ⇒ {respawn:false,pending:true}.
//   (c) the wire protocol carries the op end-to-end (DaemonOp + request + reply),
//       the RPC client auto-stamps it (authed), the control server handles it,
//       and the roster + daemon poll implement respawn-if-idle / queue + the
//       crash-handler reconfigure branch (no ceiling increment).
//
//  Pure + structural only (the LIVE kill→respawn is prove-supervise / the W6
//  daemon round-trip — registerLongLived spawns a real child, a fork-bomb under
//  `bun run`, so it is NEVER invoked here).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-reconfigure.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  workerIsIdle,
  decideReconfigure,
  deriveWireSpec,
  DEFAULT_RECONFIGURE_IDLE_MS,
} from '../../src/daemon/longLivedSupervisor.js'
import { parseScribeTargetArg, parseSeatTargetArg, reconfigureImplementer } from '../../src/utils/scribe/reconfigureImplementer.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' W2 reconfigure — per-agent targeting RPC + idle decision')
console.log('============================================================')

const NOW = 1_000_000

section('(a) workerIsIdle — the honest delivery-activity idle approximation')
check('undefined lastDeliveredAt ⇒ idle (nothing delivered / bus opted out)', workerIsIdle(undefined, NOW, 15_000) === true)
check('just delivered ⇒ NOT idle', workerIsIdle(NOW, NOW, 15_000) === false)
check('delivered 5s ago (< 15s cap) ⇒ NOT idle', workerIsIdle(NOW - 5_000, NOW, 15_000) === false)
check('delivered 20s ago (> 15s cap) ⇒ idle', workerIsIdle(NOW - 20_000, NOW, 15_000) === true)
check('default idle cap is 15s', DEFAULT_RECONFIGURE_IDLE_MS === 15_000)
check('default cap applies when idleMs omitted', workerIsIdle(NOW - 16_000, NOW) === true && workerIsIdle(NOW - 14_000, NOW) === false)

section('(b) decideReconfigure — respawn-if-idle-else-queue')
const idle = decideReconfigure({ lastDeliveredAt: undefined, now: NOW })
check('idle ⇒ respawn now, not pending', idle.respawn === true && idle.pending === false)
const busy = decideReconfigure({ lastDeliveredAt: NOW - 1_000, now: NOW })
check('busy ⇒ queue (pending), not respawn', busy.respawn === false && busy.pending === true)
const stale = decideReconfigure({ lastDeliveredAt: NOW - 30_000, now: NOW })
check('stale (idle again) ⇒ respawn now', stale.respawn === true && stale.pending === false)

section('(b2) deriveWireSpec — muster display truth (running vs requested spec)')
const RUN = { model: 'claude-opus-4-8[1m]', effort: 'max' }
const SPEC = { model: 'claude-sonnet-5', effort: 'xhigh' }
{
  const pre = deriveWireSpec({ running: undefined, spec: SPEC })
  check('pre-first-spawn falls to spec, no pending', pre.model === SPEC.model && pre.effort === SPEC.effort && pre.pendingModel === undefined && pre.pendingEffort === undefined)
  const settled = deriveWireSpec({ running: RUN, spec: RUN })
  check('running==spec ⇒ no annotation', settled.model === RUN.model && settled.pendingModel === undefined)
  const queued = deriveWireSpec({ running: RUN, spec: SPEC, pendingReconfigure: true })
  check('QUEUED retarget: wire reports RUNNING values', queued.model === RUN.model && queued.effort === RUN.effort)
  check('…with the REQUESTED spec as pending (both axes)', queued.pendingModel === SPEC.model && queued.pendingEffort === SPEC.effort)
  const inflight = deriveWireSpec({ running: RUN, spec: SPEC, reconfiguring: true })
  check('in-flight bounce also annotates pending', inflight.pendingModel === SPEC.model)
  const drifted = deriveWireSpec({ running: RUN, spec: SPEC })
  check('spec drift WITHOUT an owed bounce ⇒ no annotation (never a phantom pending)', drifted.pendingModel === undefined && drifted.pendingEffort === undefined)
  const oneAxis = deriveWireSpec({ running: RUN, spec: { model: RUN.model, effort: 'high' }, pendingReconfigure: true })
  check('per-axis: only the changed axis annotates', oneAxis.pendingModel === undefined && oneAxis.pendingEffort === 'high')
}

section('(b3) roster wires the split — structural')
{
  const roster = src('daemon', 'roster.ts')
  check('LongLivedState carries running (spawn-captured)', /running\?: \{ model: string; effort: string \}/.test(roster))
  check('spawnLongLived captures the running spec', /ll\.running = \{ model: ll\.spec\.model, effort: ll\.spec\.effort \}/.test(roster))
  check('list() derives wire model/effort via deriveWireSpec', /deriveWireSpec\(\{\s*\n\s*running: h\.longLived\.running,/.test(roster))
  const proto2 = src('daemon', 'protocol.ts')
  check('WireRosterEntry carries pendingModel/pendingEffort', /pendingModel\?: string/.test(proto2) && /pendingEffort\?: string/.test(proto2))
  const tele = src('utils', 'scribe', 'implementerTelemetry.ts')
  check('implementer telemetry distills model/effort/pending', /model: e\.model,\s*\n\s*effort: e\.effort,\s*\n\s*pendingModel: e\.pendingModel,/.test(tele))
}

section('(b4) muster persist-first reconfigure — structural (reconfigureImplementer.ts)')
{
  const ri2 = src('utils', 'scribe', 'reconfigureImplementer.ts')
  check('a model/effort patch persists via setOperatorSeatSlot BEFORE the RPC', ri2.indexOf('setOperatorSeatSlot(short') !== -1 && ri2.indexOf('setOperatorSeatSlot(short') < ri2.indexOf("op: 'reconfigure'"))
  check('a refused slot write returns without RPCing', /if \(!saved\.ok\) return saved\.message/.test(ri2))
  check('an ACK registers the receipt expectation with RESOLVED values', /registerReslotExpectation\(\{\s*\n\s*role: short,/.test(ri2))
  check('route/fable-only patches skip the slot store (posture, not reslot)', /const isReslot = patch\.model !== undefined \|\| patch\.effort !== undefined/.test(ri2))
}

section('(c) wire protocol — protocol.ts')
const proto = src('daemon', 'protocol.ts')
check("DaemonOp includes 'reconfigure'", /\|\s*'reconfigure'/.test(proto))
check('request carries short + optional model/effort', /op:\s*'reconfigure'[\s\S]{0,160}short:\s*string[\s\S]{0,80}model\?:\s*string[\s\S]{0,40}effort\?:\s*string/.test(proto))
check('reply carries respawned + pending booleans', /op:\s*'reconfigure';\s*respawned:\s*boolean;\s*pending:\s*boolean/.test(proto))

section('(d) RPC client auto-stamps reconfigure as authed — controlSocket.ts')
const sock = src('daemon', 'controlSocket.ts')
check("authed list includes reconfigure", /'reconfigure',/.test(sock))

section('(e) control server handles reconfigure — controlServer.ts')
const server = src('daemon', 'controlServer.ts')
check("case 'reconfigure' present", /case 'reconfigure':/.test(server))
check('auth-gated like the other authed ops', /case 'reconfigure':[\s\S]{0,120}verifyControlAuth/.test(server))
check('calls roster.reconfigureLongLived', /reconfigureLongLived\(short,\s*\{\s*model,\s*effort\s*\}\)/.test(server))
check('ENOJOB for a non-long-lived short', /case 'reconfigure':[\s\S]{0,1700}code:\s*'ENOJOB'/.test(server))
check('returns respawned + pending', /op:\s*'reconfigure',\s*respawned:\s*r\.respawned,\s*pending:\s*r\.pending/.test(server))

section('(f) roster implements the lifecycle — roster.ts')
const roster = src('daemon', 'roster.ts')
check('reconfigureLongLived(short, patch) exists', /reconfigureLongLived\(\s*short:\s*string,\s*patch:/.test(roster))
// P1 (router-party): the merge now routes each patched field through the
// seat-slot validators (never Haiku; a refused value FAILS CLOSED to the
// worker's CURRENT spec value) before landing in ll.spec.
check('merges only model/effort into ll.spec — via seat-slot validation', /const next = \{ \.\.\.ll\.spec \}[\s\S]{0,700}ll\.spec = next/.test(roster) && /validateSeatModel\(patch\.model,\s*prevModel\)/.test(roster) && /validateSeatEffort\(patch\.effort,\s*prevEffort as EffortValue\)/.test(roster))
// respawn-vs-queue must use the turnActive-aware isLongLivedIdle (the
// same idle definition the pending drain uses), NOT the old 15s delivery-clock
// decideReconfigure — else a clear/effort change mid-turn SIGTERMs the live turn.
check('reconfigure gates respawn on seatIsIdle (turnActive-aware)', /ll\.spec = next[\s\S]{0,1200}this\.seatIsIdle\(ll\)[\s\S]{0,160}respawnForReconfigure/.test(roster))
check('reconfigure no longer uses the delivery-clock decideReconfigure', !/decideReconfigure\(\{/.test(roster))
check('onDispatchTick records delivery + applies queued reconfigure', /onDispatchTick\(short:\s*string,\s*delivered:\s*number\)[\s\S]{0,400}lastDeliveredAt = Date\.now\(\)[\s\S]{0,300}pendingReconfigure/.test(roster))
check('handleCrash reconfigure branch: immediate respawn, no ceiling increment', /if \(ll\.reconfiguring\)[\s\S]{0,500}spawnLongLived\(short\),\s*0\)/.test(roster))
check('reconfigure branch returns BEFORE the crash counting (ll.respawns++)', roster.indexOf('if (ll.reconfiguring)') !== -1 && roster.indexOf('if (ll.reconfiguring)') < roster.indexOf('ll.respawns++'))
check('LongLivedState carries reconfiguring/pendingReconfigure/lastDeliveredAt', /reconfiguring\?:\s*boolean/.test(roster) && /pendingReconfigure\?:\s*boolean/.test(roster) && /lastDeliveredAt\?:\s*number/.test(roster))

section('(g) the daemon poll feeds onDispatchTick — main.ts')
const main = src('daemon', 'main.ts')
check('dispatch drain threads delivered count into onDispatchTick', /armDispatchDrain\([\s\S]{0,4800}onDrained: delivered => \{[\s\S]{0,120}r\.onDispatchTick\('implementer', delivered\)/.test(main))
// P1: the env-swap reads moved into resolveImplementerSeat() (seatSlots.ts) —
// same single-source guarantee, now validated (never Haiku, fail-closed).
check('Implementer spec model/effort are env-swappable (single source for reconfigure defaults)', /const seat = resolveImplementerSeat\(\)[\s\S]{0,900}model: seat\.model,\s*\n\s*effort: String\(seat\.effort\)/.test(main))

section('(h) foreground per-agent targeting — parse + caller (reconfigureImplementer.ts)')
check("parse 'implementer xhigh'", JSON.stringify(parseScribeTargetArg('implementer xhigh')) === JSON.stringify({ target: 'implementer', rest: 'xhigh' }))
check("parse 'scribe max'", JSON.stringify(parseScribeTargetArg('scribe max')) === JSON.stringify({ target: 'scribe', rest: 'max' }))
check("parse bare 'xhigh' ⇒ no target (foreground)", parseScribeTargetArg('xhigh').target === null)
check("parse 'implementer' (no level) ⇒ target + empty rest", JSON.stringify(parseScribeTargetArg('implementer')) === JSON.stringify({ target: 'implementer', rest: '' }))
// Caller, isolated from any live daemon via a non-existent config home ⇒ the
// control socket is absent ⇒ honest ENOCONN, never a fake success.
process.env.MERCURY_CONFIG_DIR = `/tmp/hermes-prove-noconfig-${process.pid}`
const offMsg = await reconfigureImplementer({ effort: 'xhigh' })
check('no daemon ⇒ honest "not reachable" (not a fabricated success)', /not reachable/.test(offMsg), offMsg)
delete process.env.MERCURY_CONFIG_DIR

section('(i) /effort arg-form wiring (effort.tsx)')
const effortSrc = src('commands', 'effort', 'effort.tsx')
// P4 (router-party): generalized to parseSeatTargetArg / ApplySeatEffortReconfigure.
check('effort routes seat tokens → reconfigure (per-mode gated)', /parseSeatTargetArg\(trimmed, \{[\s\S]{0,120}scribeOn: isScribeModeOn\(\)/.test(effortSrc))
check("daemon-seat branch → SeatReconfigure", /seat\.kind === 'daemon'[\s\S]{0,700}<SeatReconfigure/.test(effortSrc))
// (operator-ruled F4): an EXPLICIT level on a local seat token
// rides the seat machinery (ApplyLocalSeatReslot → applyOperatorReslot — the
// /model ROLES owner) instead of rewriting the global default; only the
// no-level form falls through to the foreground slider path.
check("local-seat branch: explicit level → the operator-reslot owner, else falls through", /applyOperatorReslot\(\s*\n?\s*seat\.target/.test(effortSrc) && /trimmed = rest/.test(effortSrc))

section('(j) /effort no-arg Scribe/Implementer chooser (scribe-mode interactive)')
check('has the target chooser ("which agent?")', /EffortTargetChooser/.test(effortSrc) && /which agent\?/.test(effortSrc))
check('no-arg in scribe mode routes to the chooser flow', /isScribeModeOn\(\)\)\s*\{[\s\S]{0,80}<ScribeEffortFlow/.test(effortSrc))
check('Implementer pick fires the seat-reconfigure owner', /function ImplementerSlider[\s\S]{0,1600}reconfigureSeat\('implementer', \{ effort: level \}\)/.test(effortSrc))
// Window widened: the wrapper gained the idempotence guard + the
// surfaced-receipt settle chain between its head and the slider mount.
check('Implementer slider seeds from the Implementer seat, not the Scribe', /function ImplementerSlider[\s\S]{0,400}implementerSeatView\(\)[\s\S]{0,2400}modelOverride=\{seatView\.model\}/.test(effortSrc))
check('Scribe pick uses the foreground session slider', /target === 'session'\) return <SessionSlider/.test(effortSrc) && /target === 'implementer'\) return <ImplementerSlider/.test(effortSrc))

section('(k) L-6 — the implementer SLOT is durable operator intent')
// `/model implementer gpt-5.6-sol` with Scribe OFF would otherwise answer "not found":
// the implementer token only parsed while ENGAGED. It now parses whenever the
// scribe FEATURE is enabled; the scribe LOCAL token stays engagement-gated
// (its fall-through would silently switch the foreground model).
{
  const off = parseSeatTargetArg('implementer gpt-5.6-sol', { scribeOn: false, partyEngaged: false, scribeFeatureOn: true })
  check('implementer token parses with scribe OFF but the feature enabled', off.seat?.target === 'implementer' && off.seat.kind === 'daemon' && off.rest === 'gpt-5.6-sol')
  const scribeOff = parseSeatTargetArg('scribe fable', { scribeOn: false, partyEngaged: false, scribeFeatureOn: true })
  check('scribe LOCAL token stays engagement-gated (no silent foreground switch)', scribeOff.seat === null)
  const featureOff = parseSeatTargetArg('implementer opus', { scribeOn: false, partyEngaged: false, scribeFeatureOn: false })
  check('feature off ⇒ byte-identical (token never parses)', featureOff.seat === null)
  const engaged = parseSeatTargetArg('implementer opus', { scribeOn: true, partyEngaged: false, scribeFeatureOn: true })
  check('engaged behavior unchanged', engaged.seat?.target === 'implementer' && engaged.seat.kind === 'daemon')
  // Both command callers pass the feature gate; the disengaged apply persists
  // the slot first and the unreachable note says so (reconfigureSeat).
  const modelSrc = src('commands', 'model', 'mercuryModel.tsx')
  check('/model passes scribeFeatureOn', /scribeFeatureOn: scribeModeEnabled\(\)/.test(modelSrc))
  check('/effort passes scribeFeatureOn', /scribeFeatureOn: scribeModeEnabled\(\)/.test(effortSrc))
  const reconfSrc = src('utils', 'scribe', 'reconfigureImplementer.ts')
  check('slot persists BEFORE the RPC; unreachable note names the saved slot', /setOperatorSeatSlot\(short,/.test(reconfSrc) && /Slot saved — applies at the next engage/.test(reconfSrc))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL RECONFIGURE CHECKS PASS')
else console.log(`❌ ${failures} RECONFIGURE CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
