#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-backpressure.ts
//  PROOF (Phase 2 — TaskList #29 dispatch back-pressure / #30 batching seam):
//   (i)   pure decideDispatchBackPressure — busy holds, idle/unknown deliver;
//   (ii)  pure countOpenDispatches — the shared in-flight signal (buckets);
//   (iii) the awareness HOLD clause appears iff (gate on && open>0), and the
//         reminder is byte-identical (no clause) when the gate is off / idle;
//   (iv)  the daemon bridge HOLDS a busy dispatch (unread → retry), has priority:'high'
//         JUMP the queue when idle (NOT bypass onto a busy worker), delivers when off;
//   (v)   structural wiring: roster.isWorkerBusy + main.ts gates isBusy.
//  Fake roster + temp mailbox (MERCURY_CONFIG_DIR) — no daemon, no live API.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-backpressure.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
// ROLE ENV BEFORE ANY IMPORT: isScribeModeOn() latches from MERCURY_SCRIBE at
// scribeMode.ts MODULE LOAD, and the daemon-bridge import graph reaches it
// (busBridge → engageScribeTeam/crewSpawn since the W3 mirror fold), so a
// late assignment freezes the latch OFF and every awareness reminder composes
// empty. A REAL Scribe process has the env from spawn — this mirrors that.
process.env.MERCURY_SCRIBE = '1'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const sup = (await import('../../src/daemon/longLivedSupervisor.js')) as typeof import('../../src/daemon/longLivedSupervisor.js')
const tabs = (await import('../../src/components/mercury-ui/scribeChatTabs.js')) as typeof import('../../src/components/mercury-ui/scribeChatTabs.js')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')
const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')

console.log('============================================================')
console.log(' Dispatch back-pressure / stagger (#29) — proof')
console.log('============================================================')

section('(i) decideDispatchBackPressure (pure)')
const NOW = 1_000_000
check('nothing dispatched (undefined) ⇒ no hold, reason unknown', JSON.stringify(sup.decideDispatchBackPressure({ lastDeliveredAt: undefined, now: NOW })) === JSON.stringify({ hold: false, reason: 'unknown' }))
check('delivered 1s ago (within 15s) ⇒ HOLD, reason busy', sup.decideDispatchBackPressure({ lastDeliveredAt: NOW - 1000, now: NOW }).hold === true)
check('delivered 30s ago (past idle) ⇒ no hold, reason idle', JSON.stringify(sup.decideDispatchBackPressure({ lastDeliveredAt: NOW - 30_000, now: NOW })) === JSON.stringify({ hold: false, reason: 'idle' }))
check('busy but maxInFlight=3 (batching window) ⇒ no hold', sup.decideDispatchBackPressure({ lastDeliveredAt: NOW - 1000, now: NOW, maxInFlight: 3 }).hold === false)

section('(ii) countOpenDispatches (pure, the shared in-flight signal)')
const d1 = bus.buildDispatch('scribe', 'task one', { title: 'One' })
const d2 = bus.buildDispatch('scribe', 'task two', { title: 'Two' })
// request_id is now per-process MONOTONIC (agentId.ts generateRequestId appends a `.seq`),
// so back-to-back buildDispatch calls get distinct ids even within the same millisecond —
// the old hand-patch that forced distinct ids here is absent (de-staled on contact). Assert
// the fix at the exact spot that would otherwise need the workaround:
check('back-to-back buildDispatch ⇒ DISTINCT request_ids (monotonic; no same-ms collision)', d1.request_id !== d2.request_id)
const ser = (e: unknown) => ({ type: 'user', message: { role: 'user', content: bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0]) } })
const wrap = (from: string, e: unknown) => ({ type: 'user', message: { role: 'user', content: `<teammate-message teammate_id="${from}" color="#3FBFA0">\n${bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0])}\n</teammate-message>` } })
const twoOpen = [ser(d1), ser(d2)]
check('2 dispatched, none advanced ⇒ open=2', tabs.countOpenDispatches(twoOpen).open === 2)
const oneDone = [ser(d1), ser(d2), wrap('implementer', bus.buildProgress('implementer', 'done', { refRequestId: d1.request_id }))]
const c = tabs.countOpenDispatches(oneDone)
check('one advanced to done ⇒ open=1, done=1, total=2', c.open === 1 && c.done === 1 && c.total === 2)
check('empty transcript ⇒ open=0', tabs.countOpenDispatches([]).open === 0)

section('(iii) awareness HOLD clause: gate-on+open ⇒ clause; gate-off ⇒ byte-identical')
// (MERCURY_SCRIBE was set BEFORE the imports above — the scribeMode latch reads
// it at module load; see the header note.)
const aware = (await import('../../src/utils/scribe/scribeAwareness.js')) as typeof import('../../src/utils/scribe/scribeAwareness.js')
delete process.env.MERCURY_SCRIBE_BACKPRESSURE // gate on (fork default)
const onText = aware.buildScribeAwarenessReminder(twoOpen)
check('gate ON + 2 open ⇒ HOLD clause present', /still in flight/.test(onText) && /HOLD a new/.test(onText))
check('gate ON + open ⇒ supersede + batch guidance present', /SUPERSEDE/.test(onText) && /[Bb]atch related/.test(onText))
process.env.MERCURY_SCRIBE_BACKPRESSURE = '0' // gate off
const offText = aware.buildScribeAwarenessReminder(twoOpen)
check('gate OFF ⇒ NO HOLD clause (byte-identical to no-backpressure)', !/still in flight/.test(offText))
delete process.env.MERCURY_SCRIBE_BACKPRESSURE
// no open dispatches ⇒ no clause even gate-on
check('gate ON + 0 open ⇒ no HOLD clause', !/still in flight/.test(aware.buildScribeAwarenessReminder([])))
delete process.env.MERCURY_SCRIBE

section('(iv) bridge: busy holds dispatches; priority:high JUMPS the queue (not bypass); gate-off delivers all')
const tmp = mkdtempSync(join(tmpdir(), 'hermes-bp-'))
process.env.MERCURY_CONFIG_DIR = tmp
const mailbox = await import('../../src/utils/teammateMailbox.js')
const seed = async (e: unknown) => mailbox.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0]), timestamp: new Date().toISOString() }, 'scribe')
const mkRoster = (rec: string[]) => ({ reply: async (_s: string, text: string) => { rec.push(text); return true } })

// busy + normal dispatch ⇒ held (0 delivered), left unread
await seed(bus.buildDispatch('scribe', 'normal task'))
const recBusy: string[] = []
const delBusy = await bridge.drainScribeDispatches(mkRoster(recBusy), { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => true })
check('busy + normal dispatch ⇒ HELD (0 delivered)', delBusy === 0 && recBusy.length === 0)
// now idle ⇒ the SAME unread dispatch retries + delivers
const recIdle: string[] = []
const delIdle = await bridge.drainScribeDispatches(mkRoster(recIdle), { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false })
check('idle ⇒ the held dispatch retries + delivers (1)', delIdle === 1 && recIdle.some(t => t.includes('normal task')))

// priority:high JUMPS the queue when idle, but does NOT bypass onto a BUSY worker
// (#41 R1c — the old "high bypasses while busy" delivered a 2nd task onto a mid-task
// Implementer, breaking "strictly one at a time"; high now jumps the queue instead).
const tmp2 = mkdtempSync(join(tmpdir(), 'hermes-bp2-'))
process.env.MERCURY_CONFIG_DIR = tmp2
await seed(bus.buildDispatch('scribe', 'urgent task', { priority: 'high' }))
const recHigh: string[] = []
const delHigh = await bridge.drainScribeDispatches(mkRoster(recHigh), { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => true })
check('priority:high while BUSY ⇒ HELD (no bypass onto a busy worker — strictly one at a time)', delHigh === 0 && recHigh.length === 0)
// idle + [normal queued first, then high]: high JUMPS the queue (the one delivered is the high)
const tmp2b = mkdtempSync(join(tmpdir(), 'hermes-bp2b-'))
process.env.MERCURY_CONFIG_DIR = tmp2b
await seed(bus.buildDispatch('scribe', 'normal first'))
await seed(bus.buildDispatch('scribe', 'urgent second', { priority: 'high' }))
const recJump: string[] = []
const delJump = await bridge.drainScribeDispatches(mkRoster(recJump), { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false })
check('idle + [normal, high] ⇒ exactly ONE delivered, and it is the HIGH (jumps the queue)', delJump === 1 && recJump.length === 1 && recJump[0]!.includes('urgent second'))

// gate off (no isBusy) ⇒ delivers immediately regardless of busy
const tmp3 = mkdtempSync(join(tmpdir(), 'hermes-bp3-'))
process.env.MERCURY_CONFIG_DIR = tmp3
await seed(bus.buildDispatch('scribe', 'gate-off task'))
const recOff: string[] = []
const delOff = await bridge.drainScribeDispatches(mkRoster(recOff), { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
check('gate OFF (no isBusy) ⇒ delivers immediately (byte-identical)', delOff === 1 && recOff.some(t => t.includes('gate-off task')))
delete process.env.MERCURY_CONFIG_DIR

section('(v) structural wiring')
const roster = src('daemon', 'roster.ts')
check('roster exposes public isWorkerBusy', /isWorkerBusy\(short: string\): boolean/.test(roster))
const main = src('daemon', 'main.ts')
check('main.ts gates isBusy behind scribeBackPressureEnabled', /scribeBackPressureEnabled\(\)/.test(main) && /isBusy: backPressure \? \(\) => r\.isWorkerBusy\('implementer'\) : undefined/.test(main))
const gates = src('utils', 'scribe', 'scribeGates.ts')
check('scribeBackPressureEnabled gate exists (MERCURY_SCRIBE_BACKPRESSURE)', /export function scribeBackPressureEnabled/.test(gates) && /MERCURY_SCRIBE_BACKPRESSURE/.test(gates))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BACK-PRESSURE PROOFS PASS')
else console.log(`❌ ${failures} BACK-PRESSURE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
