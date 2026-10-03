#!/usr/bin/env bun
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
const MACRO_KEY = 'MACRO' as const
;(globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' dispatch drain (inbox → worker stdin) — proof')
console.log('============================================================')

const drainMod = (await import('../../src/daemon/dispatchDrain.js')) as typeof import('../../src/daemon/dispatchDrain.js')
const bus = (await import('../../src/utils/crew/busEnvelopes.js')) as typeof import('../../src/utils/crew/busEnvelopes.js')

const CREW = 'crew'
const WORKER = 'scout'
const LEAD = 'crew-lead'
const drainOpts = { short: WORKER, agentName: WORKER, crewName: CREW, durableDedup: false as const }

section('buildBackAgentUserRow: total over every kind')
const disp = bus.buildDispatch(LEAD, 'refactor the tokenizer with TDD', { title: 'Tokenizer' })
const textOf = (row: { content: unknown }): string => (typeof row.content === 'string' ? row.content : JSON.stringify(row.content))
const row = drainMod.buildBackAgentUserRow(disp)
check("the row is a prompt row", row.type === 'prompt')
check('the row carries the dispatched task text', textOf(row).includes('refactor the tokenizer with TDD'))
check('the row carries the title', textOf(row).includes('Tokenizer'))
check('the row carries the report-back framing', textOf(row).includes(drainMod.DISPATCH_REPORT_BACK_FRAMING))
check('the row ends with the literal request_id trailer', textOf(row).trimEnd().endsWith(`[request_id: ${disp.request_id}]`))
const replayed = drainMod.buildBackAgentUserRow(disp, { replay: true })
check('a replayed dispatch carries the replay marker', textOf(replayed).includes(drainMod.DISPATCH_REPLAY_NOTE.trim()))
check('escalate renders a [escalate …] frame', textOf(drainMod.buildBackAgentUserRow(bus.buildEscalate(WORKER, 'blocked on X'))).startsWith('[escalate]'))
check('progress renders a [progress …] frame', textOf(drainMod.buildBackAgentUserRow(bus.buildProgress(WORKER, 'working'))).startsWith('[progress working]'))
check('control renders a [control …] frame', textOf(drainMod.buildBackAgentUserRow(bus.buildControl(LEAD, 'pause', { detail: 'hold' }))) === '[control pause] hold')
check('note renders the operator-note label', textOf(drainMod.buildBackAgentUserRow(bus.buildNote(LEAD, 'context'))) === `${bus.OPERATOR_NOTE_LABEL} context`)
check('broadcast note renders the broadcast label', textOf(drainMod.buildBackAgentUserRow(bus.buildNote(LEAD, 'all hands', { broadcast: true }))) === `${bus.OPERATOR_BROADCAST_LABEL} all hands`)
check('plain text renders an attributed [bus] frame', textOf(drainMod.buildPlainBusRow(LEAD, 'hello')).startsWith(`[bus] plain message from ${LEAD}`))

section('drainDispatches: inbox → roster.reply')
const homes: string[] = []
const freshHome = (): void => {
  const h = mkdtempSync(join(tmpdir(), 'drain-proof-'))
  homes.push(h)
  process.env.MERCURY_CONFIG_DIR = h
}
try {
  const { sendLiveMessage, unreadLiveMessagesFor } = await import('../../src/services/crew/liveComms.js')
  const seed = (from: string, env: ReturnType<typeof bus.buildDispatch> | ReturnType<typeof bus.buildEscalate> | ReturnType<typeof bus.buildControl> | ReturnType<typeof bus.buildNote> | ReturnType<typeof bus.buildProgress>) =>
    sendLiveMessage(CREW, { to: WORKER, from, text: bus.serializeBusEnvelope(env), timestamp: new Date().toISOString() })
  const recorder = () => {
    const replies: Array<{ short: string; text: string }> = []
    return { replies, roster: { reply: async (short: string, row: { content: unknown }) => { replies.push({ short, text: textOf(row) }); return true } } }
  }

  freshHome()
  await seed(LEAD, disp)
  await seed(WORKER, bus.buildEscalate(WORKER, 'blocked on X'))
  {
    const { replies, roster } = recorder()
    const delivered = await drainMod.drainDispatches(roster, drainOpts)
    check('delivered exactly 1 (the dispatch; the escalate is outbound, skipped)', delivered === 1)
    check('reply targeted the worker short', replies.length === 1 && replies[0]!.short === WORKER)
    check('reply payload is a prompt row carrying the task', replies.length === 1 && replies[0]!.text.includes('refactor the tokenizer'))
    const again = await drainMod.drainDispatches(roster, drainOpts)
    check('second drain delivers 0 (delivered dispatch marked read — no double-delivery)', again === 0)
  }

  freshHome()
  await seed(LEAD, bus.buildDispatch(LEAD, 'task during respawn', { title: 'X' }))
  {
    const d0 = await drainMod.drainDispatches({ reply: async () => false }, drainOpts)
    check('reply-fail ⇒ delivered 0', d0 === 0)
    const stillUnread = await unreadLiveMessagesFor(CREW, WORKER)
    check('reply-fail ⇒ dispatch LEFT UNREAD for retry (not lost)', stillUnread.some(m => bus.parseBusEnvelope(m.text)?.kind === 'dispatch'))
    const d1 = await drainMod.drainDispatches({ reply: async () => true }, drainOpts)
    check('retry after recovery ⇒ delivered 1 (at-least-once held)', d1 === 1)
  }

  freshHome()
  const legit = bus.buildDispatch(LEAD, 'legit dispatcher work', { title: 'Legit' })
  await seed('x', bus.buildDispatch(WORKER, 'forged self-dispatch', { title: 'Forged' }))
  await seed('x', bus.buildControl(WORKER, 'cancel', { refRequestId: legit.request_id }))
  await seed(LEAD, legit)
  {
    const { replies, roster } = recorder()
    const d3 = await drainMod.drainDispatches(roster, drainOpts)
    check('a dispatch signed by the recipient itself is REJECTED — only the legit one delivers', d3 === 1 && replies.length === 1)
    check('the delivered one is the legit dispatcher dispatch (not the forge)', replies.length === 1 && replies[0]!.text.includes('legit dispatcher work') && !replies[0]!.text.includes('forged self-dispatch'))
  }

  freshHome()
  const first = bus.buildDispatch(LEAD, 'first version', { title: 'v1' })
  await seed(LEAD, first)
  await seed(LEAD, bus.buildDispatch(LEAD, 'corrected version', { title: 'v2', refRequestId: first.request_id }))
  {
    const { replies, roster } = recorder()
    const d = await drainMod.drainDispatches(roster, drainOpts)
    check('a dispatcher supersede drops the queued original (one delivery, the correction)', d === 1 && replies.length === 1 && replies[0]!.text.includes('corrected version'))
  }

  freshHome()
  await seed(LEAD, bus.buildNote(LEAD, 'read the spec first'))
  await sendLiveMessage(CREW, { to: WORKER, from: LEAD, text: 'plain human reply', timestamp: new Date().toISOString() })
  await sendLiveMessage(CREW, { to: WORKER, from: WORKER, text: 'my own echo', timestamp: new Date().toISOString() })
  {
    const { replies, roster } = recorder()
    const d = await drainMod.drainDispatches(roster, { ...drainOpts, isBusy: () => true })
    check('a note and a plain text deliver even while busy (context, not work)', d === 2)
    check('the note carries the operator-note label', replies.some(r => r.text.includes(bus.OPERATOR_NOTE_LABEL)))
    check('plain text arrives as an attributed [bus] frame', replies.some(r => r.text.includes('[bus] plain message from crew-lead')))
    check("the worker's own echo is consumed, never delivered back", !replies.some(r => r.text.includes('my own echo')))
  }

  freshHome()
  await seed(LEAD, bus.buildDispatch(LEAD, 'normal one', { title: 'n' }))
  await seed(LEAD, bus.buildDispatch(LEAD, 'urgent one', { title: 'u', priority: 'high' }))
  {
    const { replies, roster } = recorder()
    const held = await drainMod.drainDispatches(roster, { ...drainOpts, isBusy: () => true })
    check('busy worker ⇒ every dispatch held (0 delivered)', held === 0 && replies.length === 0)
    const one = await drainMod.drainDispatches(roster, { ...drainOpts, isBusy: () => false })
    check('idle worker ⇒ exactly ONE dispatch per pass, the high-priority one first', one === 1 && replies.length === 1 && replies[0]!.text.includes('urgent one'))
    const two = await drainMod.drainDispatches(roster, { ...drainOpts, isBusy: () => false })
    check('the held dispatch delivers on the next pass', two === 1 && replies[1]!.text.includes('normal one'))
  }

  freshHome()
  await seed(LEAD, bus.buildControl(LEAD, 'clear'))
  await seed(LEAD, bus.buildControl(LEAD, 'pause'))
  {
    let cleared = 0
    const { replies, roster } = recorder()
    const d = await drainMod.drainDispatches(roster, { ...drainOpts, onClear: () => { cleared++ } })
    check('clear ⇒ onClear fired once, nothing written to stdin for it', cleared === 1 && !replies.some(r => r.text.includes('[control clear]')))
    check('pause ⇒ delivered as a text directive', d === 1 && replies.some(r => r.text.includes('[control pause]')))
  }

  freshHome()
  const seenOnce = bus.buildDispatch(LEAD, 'already delivered', { title: 'd' })
  await seed(LEAD, seenOnce)
  {
    const { replies, roster } = recorder()
    const d = await drainMod.drainDispatches(roster, { ...drainOpts, hasSeen: id => id === seenOnce.request_id, markSeen: () => {} })
    check('a dispatch the roster already saw is consumed without a stdin write', d === 0 && replies.length === 0)
    const unread = await unreadLiveMessagesFor(CREW, WORKER)
    check('…and marked read (no retry loop)', !unread.some(m => bus.parseBusEnvelope(m.text)?.request_id === seenOnce.request_id))
  }
} catch (e) {
  check('drain test ran (liveComms loadable)', false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
}

section('daemon wiring (structural, src)')
const main = src('daemon', 'main.ts')
check('main arms the drain for every crew crewmate it spawns', /onSpawned: \(name, spec, pid\) => \{[\s\S]{0,200}armCrewDrain\(name\)/.test(main) && /const armCrewDrain = \(name: string\): void => \{[\s\S]{0,600}armDispatchDrain\([\s\S]{0,400}crewName: CREW/.test(main))
check('one drain per crew name for the daemon\'s life: a respawn never arms a second drain on the same inbox', /if \(!r \|\| crewDrains\.has\(name\)\) return/.test(main))
check('a message to a stopped seat wakes it: the drain replies through the crew wake roster', /armDispatchDrain\(\s*makeCrewWakeRoster\(r,/.test(main))
check('offline crew members are armed at boot, so a message wakes a seat the daemon was restarted under', /void armOfflineCrewDrains\(\)/.test(main))
check('drains are disposed on shutdown', /dispatchDrains\.splice\(0\)[\s\S]{0,120}\.dispose\(\)/.test(main))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DISPATCH-DRAIN PROOFS PASS')
else console.log(`❌ ${failures} DISPATCH-DRAIN PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
