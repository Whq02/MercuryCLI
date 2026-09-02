#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-burst.ts
//  PROOF (#41 R1 + R4 burst harness): the bundling is correct UNDER BURST — the
//  load case the doctrine alone never guaranteed. Drives the REAL drain +
//  countOpenDispatches over a synthetic clock with a fake roster + temp mailbox:
//   (1) NO silent ledger merge — a same-ms burst keeps countOpenDispatches.open
//       accurate (the monotonic request_id fix; this FAILED before it);
//   (2) DEDUP — an at-least-once redelivery of an already-delivered request_id is
//       dropped, never re-executed (the robust request_id key);
//   (3) SUPERSEDE — a dispatch (refRequestId) / control 'cancel' drops the queued
//       target; the correction doesn't stack behind the work it replaces;
//   (4) PRIORITY JUMP — a high-priority dispatch is delivered first among queued,
//       but never bypasses onto a busy worker (still one-at-a-time).
//  Pure/API-free (synthetic) — proves the daemon-side serialization + correctness
//  invariants, NOT live model quality (that is the live smoke's job).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-burst.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
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

const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')
const mb = (await import('../../src/utils/teammateMailbox.js')) as typeof import('../../src/utils/teammateMailbox.js')
const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')
const tabs = (await import('../../src/components/mercury-ui/scribeChatTabs.js')) as typeof import('../../src/components/mercury-ui/scribeChatTabs.js')

const SAVE = process.env.MERCURY_CONFIG_DIR
const freshTeam = () => {
  const d = mkdtempSync(join(tmpdir(), 'prove-burst-'))
  process.env.MERCURY_CONFIG_DIR = d
}
const seed = (e: unknown, tsOffset = 0) =>
  mb.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0]), timestamp: new Date(1_700_000_000_000 + tsOffset).toISOString() }, 'scribe')
const ser = (e: unknown) => ({ type: 'user', message: { role: 'user', content: bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0]) } })

console.log('============================================================')
console.log(' Bundling under BURST — correctness harness (#41 R1 / R4)')
console.log('============================================================')

section('(1) NO silent ledger merge under a same-ms burst (monotonic request_id)')
// 8 dispatches minted back-to-back (same millisecond) — must be 8 DISTINCT ledger entries.
const burst = Array.from({ length: 8 }, (_, i) => bus.buildDispatch('scribe', `burst task ${i + 1}`, { title: `B${i + 1}` }))
check('8 same-ms dispatches ⇒ 8 distinct request_ids (no collision)', new Set(burst.map(d => d.request_id)).size === 8)
const openCount = tabs.countOpenDispatches(burst.map(ser))
check('countOpenDispatches.open === 8 (no silent merge — the in-flight signal is accurate)', openCount.open === 8, `open=${openCount.open}`)

section('(2) DEDUP — an already-delivered request_id is never re-executed')
freshTeam()
const seen = new Set<string>()
const recD: string[] = []
const rosterD = { reply: async (_s: string, t: string) => { recD.push(t); return true } }
const drainD = () => bridge.drainScribeDispatches(rosterD, { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false, hasSeen: (id: string) => seen.has(id), markSeen: (id: string) => void seen.add(id) })
const dd = bus.buildDispatch('scribe', 'once-only task', { title: 'Once' })
await seed(dd, 1)
const d1 = await drainD()
check('first delivery ⇒ delivered once + recorded seen', d1 === 1 && recD.length === 1 && seen.has(dd.request_id))
// re-seed the SAME envelope (an at-least-once redelivery across a crash/respawn)
await seed(dd, 2)
const d2 = await drainD()
check('redelivery of the SAME request_id ⇒ DROPPED (not delivered again)', d2 === 0 && recD.length === 1)

section('(3) SUPERSEDE — a refRequestId dispatch drops the queued target')
freshTeam()
const a = bus.buildDispatch('scribe', 'stale approach', { title: 'A' })
const b = bus.buildDispatch('scribe', 'corrected approach', { title: 'B', refRequestId: a.request_id })
await seed(a, 1)
await seed(b, 2)
const recS: string[] = []
const rosterS = { reply: async (_s: string, t: string) => { recS.push(t); return true } }
const ds = await bridge.drainScribeDispatches(rosterS, { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false })
check('A superseded by B ⇒ exactly ONE delivered, and it is B (the correction)', ds === 1 && recS.length === 1 && recS[0]!.includes('corrected approach') && !recS[0]!.includes('stale approach'))
// the superseded A must be consumed (marked read), not left to retry
const stillUnread = await mb.readUnreadMessages('implementer', 'scribe')
check('the superseded A is marked read (does not retry forever)', stillUnread.length === 0, `unread=${stillUnread.length}`)

section('(3b) control CANCEL drops a queued dispatch')
freshTeam()
const target = bus.buildDispatch('scribe', 'cancel me', { title: 'X' })
const cancel = bus.buildControl('scribe', 'cancel', { refRequestId: target.request_id })
await seed(target, 1)
await seed(cancel, 2)
const recC: string[] = []
const rosterC = { reply: async (_s: string, t: string) => { recC.push(t); return true } }
const dc = await bridge.drainScribeDispatches(rosterC, { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => false })
check('cancel(ref=target) ⇒ the target dispatch is NOT delivered (dropped)', !recC.some(t => t.includes('cancel me')))
check('after cancel, inbox drained (target + cancel both consumed)', (await mb.readUnreadMessages('implementer', 'scribe')).length === 0)

section('(4) PRIORITY JUMP under burst — high first, still one-at-a-time, FIFO within priority')
freshTeam()
await seed(bus.buildDispatch('scribe', 'normal one'), 1)
await seed(bus.buildDispatch('scribe', 'normal two'), 2)
await seed(bus.buildDispatch('scribe', 'URGENT', { priority: 'high' }), 3)
await seed(bus.buildDispatch('scribe', 'normal three'), 4)
let turnActive = false
const order: string[] = []
const rosterP = { reply: async (_s: string, t: string) => { order.push(t.match(/normal \w+|URGENT/)?.[0] ?? '?'); turnActive = true; return true } }
const drainP = () => bridge.drainScribeDispatches(rosterP, { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => turnActive })
const perRound: number[] = []
let guard = 0
while (order.length < 4 && guard < 50) {
  guard++
  const d = await drainP()
  perRound.push(d)
  if (d > 0) { /* turn completes */ turnActive = false }
}
check('every drain delivered ≤1 (one task at a time under mixed priority)', perRound.every(x => x <= 1), `rounds=${JSON.stringify(perRound)}`)
check('HIGH was delivered FIRST (jumped ahead of the earlier-queued normals)', order[0] === 'URGENT', `order=${JSON.stringify(order)}`)
check('all 4 eventually delivered, normals in FIFO after the jump', order.length === 4 && order.slice(1).join(',') === 'normal one,normal two,normal three', `order=${JSON.stringify(order)}`)

SAVE === undefined ? delete process.env.MERCURY_CONFIG_DIR : (process.env.MERCURY_CONFIG_DIR = SAVE)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BURST PROOFS PASS')
else console.log(`❌ ${failures} BURST PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
