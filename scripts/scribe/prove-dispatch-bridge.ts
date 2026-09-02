#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-dispatch-bridge.ts
//  PROOF (bus Gap 2): the daemon-side dispatch→stdin bridge. A dispatch landing
//  in the Implementer's mailbox inbox is delivered to its stdin as a stream-json
//  user frame via the EXISTING roster.reply→stdin channel. Verified with a FAKE
//  roster + a temp mailbox (MERCURY_CONFIG_DIR) — no real daemon, no live API.
//  The turn-EXECUTION (a real opus-4-8 child running the frame) is the live-API
//  gate, not run here.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-dispatch-bridge.ts
// ============================================================================
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
console.log(' Scribe dispatch→stdin bridge (Gap 2) — proof')
console.log('============================================================')

const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')
const busmod = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

section('buildBackAgentUserFrame: wraps a dispatch as a stream-json user frame')
const disp = busmod.buildDispatch('scribe', 'refactor the tokenizer with TDD', { title: 'Tokenizer' })
const frameStr = bridge.buildBackAgentUserFrame(disp)
const frame = JSON.parse(frameStr)
check("frame.type === 'user'", frame.type === 'user')
check("frame.message.role === 'user'", frame.message?.role === 'user')
check('frame carries the dispatched task text', typeof frame.message?.content === 'string' && frame.message.content.includes('refactor the tokenizer with TDD'))
check('frame carries the title', frame.message.content.includes('Tokenizer'))
// The renderer is TOTAL (renders all kinds); whether escalate/progress are
// DELIVERED is the drain's call (deliverReplies), proven below (the routing
// proof of the retired seat estate held the other half and left with it).
const esc = busmod.buildEscalate('implementer', 'blocked on X')
check('escalate now renders to a non-empty [escalate …] frame', JSON.parse(bridge.buildBackAgentUserFrame(esc)).message.content.includes('escalate'))

section('drainScribeDispatches: delivers inbox dispatches to the child via roster.reply')
const tmp = mkdtempSync(join(tmpdir(), 'hermes-bridge-'))
process.env.MERCURY_CONFIG_DIR = tmp
try {
  const mailbox = await import('../../src/utils/teammateMailbox.js')
  // Seed the Implementer's inbox with a dispatch + an unrelated escalate.
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: busmod.serializeScribeEnvelope(disp), timestamp: new Date().toISOString() }, 'scribe')
  await mailbox.writeToMailbox('implementer', { from: 'implementer', text: busmod.serializeScribeEnvelope(esc), timestamp: new Date().toISOString() }, 'scribe')

  // Fake roster: records every reply(short,text).
  const replies: Array<{ short: string; text: string }> = []
  const fakeRoster = { reply: async (short: string, text: string) => { replies.push({ short, text }); return true } }

  const delivered = await bridge.drainScribeDispatches(fakeRoster, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('delivered exactly 1 (the dispatch; the escalate is outbound, skipped)', delivered === 1)
  check('reply targeted the implementer short id', replies.length === 1 && replies[0]!.short === 'implementer')
  check('reply payload is a user frame carrying the task', replies.length === 1 && JSON.parse(replies[0]!.text).message.content.includes('refactor the tokenizer'))

  // Idempotent: a second drain finds nothing (delivered + non-inbound marked read).
  const again = await bridge.drainScribeDispatches(fakeRoster, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('second drain delivers 0 (delivered dispatch marked read — no double-delivery)', again === 0)

  // AT-LEAST-ONCE (audit-4 #1): a reply FAILURE (e.g. the Implementer respawn
  // window) must LEAVE the dispatch unread so the next poll retries — never lost.
  const tmp2 = mkdtempSync(join(tmpdir(), 'hermes-bridge2-'))
  process.env.MERCURY_CONFIG_DIR = tmp2
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: busmod.serializeScribeEnvelope(busmod.buildDispatch('scribe', 'task during respawn', { title: 'X' })), timestamp: new Date().toISOString() }, 'scribe')
  const failRoster = { reply: async () => false } // simulate the respawn window (stdin not writable)
  const d0 = await bridge.drainScribeDispatches(failRoster, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('reply-fail ⇒ delivered 0', d0 === 0)
  const stillUnread = await mailbox.readUnreadMessages('implementer', 'scribe')
  check('reply-fail ⇒ dispatch LEFT UNREAD for retry (not lost)', stillUnread.some(m => busmod.parseScribeEnvelope(m.text)?.kind === 'dispatch'))
  // Now the Implementer is back: a retry delivers it.
  const okRoster = { reply: async () => true }
  const d1 = await bridge.drainScribeDispatches(okRoster, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('retry after recovery ⇒ delivered 1 (at-least-once held)', d1 === 1)

  // SECURITY: a dispatch/control from 'implementer' (forged / role-confused
  // — the inbox is a local file any same-user process can append to) is REJECTED,
  // never reaching the Implementer's own stdin; and a forged cancel cannot
  // supersede a legitimate dispatcher dispatch.
  const tmp3 = mkdtempSync(join(tmpdir(), 'hermes-bridge3-'))
  process.env.MERCURY_CONFIG_DIR = tmp3
  const legit = busmod.buildDispatch('scribe', 'legit dispatcher work', { title: 'Legit' })
  const forgedDispatch = busmod.buildDispatch('implementer', 'forged self-dispatch', { title: 'Forged' })
  const forgedCancel = busmod.buildControl('implementer', 'cancel', { refRequestId: legit.request_id })
  await mailbox.writeToMailbox('implementer', { from: 'x', text: busmod.serializeScribeEnvelope(forgedDispatch), timestamp: new Date().toISOString() }, 'scribe')
  await mailbox.writeToMailbox('implementer', { from: 'x', text: busmod.serializeScribeEnvelope(forgedCancel), timestamp: new Date().toISOString() }, 'scribe')
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: busmod.serializeScribeEnvelope(legit), timestamp: new Date().toISOString() }, 'scribe')
  const rep3: Array<{ short: string; text: string }> = []
  const roster3 = { reply: async (short: string, text: string) => { rep3.push({ short, text }); return true } }
  const d3 = await bridge.drainScribeDispatches(roster3, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('forged from=implementer dispatch is REJECTED — only the legit one delivers', d3 === 1 && rep3.length === 1)
  check('the delivered one is the legit dispatcher dispatch (not the forge)', rep3.length === 1 && rep3[0]!.text.includes('legit dispatcher work') && !rep3[0]!.text.includes('forged self-dispatch'))
  check('forged cancel from implementer did NOT supersede the legit dispatch', rep3.some(r => r.text.includes('legit dispatcher work')))
} catch (e) {
  check(`drain test ran (teammateMailbox loadable)`, false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
}

section('daemon wiring (structural, src) — gated + cleaned up')
const main = src('daemon', 'main.ts')
check('main imports the bridge', /armDispatchDrain/.test(main))
check('drain is gated on scribeBusLiveEnabled (default ON for fork, opt-out =0)', /scribeBusLiveEnabled\(\)[\s\S]{0,3600}armDispatchDrain/.test(main))
check('drain is disposed on shutdown', /dispatchDrains\.splice\(0\)[\s\S]{0,120}\.dispose\(\)/.test(main))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DISPATCH-BRIDGE PROOFS PASS')
else console.log(`❌ ${failures} DISPATCH-BRIDGE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
