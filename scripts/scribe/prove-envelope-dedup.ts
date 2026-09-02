#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-envelope-dedup.ts
//  PROOF: batch-dedup by request_id in drainScribeDispatches (reactive-substrate
//  Phase 2 socket fallback). The socket-first sender re-journals an envelope to
//  the mailbox when the control-socket RPC reply is lost, so TWO records with
//  the SAME request_id can be unread together — with back-pressure OFF (or on
//  the party path) both twins would otherwise execute. Verified with a FAKE roster +
//  a temp mailbox (MERCURY_CONFIG_DIR) — no real daemon, no live API. Also
//  re-pins the role gate (from:'implementer' work is rejected) and that
//  dedup never drops DISTINCT dispatches.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-envelope-dedup.ts
// ============================================================================
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
const MACRO_KEY = 'MACRO' as const
;(globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' Scribe envelope batch-dedup (request_id twins) — proof')
console.log('============================================================')

const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')
const busmod = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

section('(1) DEDUP: two unread records with the SAME request_id deliver ONCE')
const tmp1 = mkdtempSync(join(tmpdir(), 'hermes-dedup1-'))
process.env.MERCURY_CONFIG_DIR = tmp1
try {
  const mailbox = await import('../../src/utils/teammateMailbox.js')
  // The lost-RPC-reply shape: ONE envelope, journaled TWICE (socket ingress
  // journaled it, the sender's fallback re-journaled the same envelope).
  const twin = busmod.buildDispatch('scribe', 'dedup me once', { title: 'Twin' })
  const twinText = busmod.serializeScribeEnvelope(twin)
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: twinText, timestamp: '2026-07-01T00:00:00.000Z' }, 'scribe')
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: twinText, timestamp: '2026-07-01T00:00:01.000Z' }, 'scribe')

  const replies: string[] = []
  const roster = { reply: async (_short: string, text: string) => { replies.push(text); return true } }
  // Back-pressure OFF (no isBusy) — the path that would otherwise deliver BOTH twins.
  await bridge.drainScribeDispatches(roster, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('roster.reply called EXACTLY once (the twin deduped, not double-executed)', replies.length === 1, `got ${replies.length}`)
  check('the delivered frame is the dispatch', replies.length === 1 && JSON.parse(replies[0]!).message.content.includes('dedup me once'))
  const left1 = await mailbox.readUnreadMessages('implementer', 'scribe')
  check('BOTH records consumed (the deduped twin marked read too)', left1.length === 0, `still unread: ${left1.length}`)
  // Idempotent: a re-drain finds nothing to re-execute.
  const replies1b: string[] = []
  const roster1b = { reply: async (_short: string, text: string) => { replies1b.push(text); return true } }
  await bridge.drainScribeDispatches(roster1b, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('second drain delivers 0', replies1b.length === 0)
} catch (e) {
  check('dedup test ran (teammateMailbox loadable)', false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
}

section("(2) ROLE (HB-0067): a dispatch from:'implementer' is REJECTED + consumed")
const tmp2 = mkdtempSync(join(tmpdir(), 'hermes-dedup2-'))
process.env.MERCURY_CONFIG_DIR = tmp2
try {
  const mailbox = await import('../../src/utils/teammateMailbox.js')
  const forged = busmod.buildDispatch('implementer', 'forged self-work', { title: 'Forged' })
  await mailbox.writeToMailbox('implementer', { from: 'x', text: busmod.serializeScribeEnvelope(forged), timestamp: new Date().toISOString() }, 'scribe')
  const replies2: string[] = []
  const roster2 = { reply: async (_short: string, text: string) => { replies2.push(text); return true } }
  await bridge.drainScribeDispatches(roster2, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('roster.reply NOT called for the forged dispatch', replies2.length === 0, `got ${replies2.length}`)
  const left2 = await mailbox.readUnreadMessages('implementer', 'scribe')
  check('the forged record is consumed (marked read, not retried forever)', left2.length === 0, `still unread: ${left2.length}`)
} catch (e) {
  check('role test ran (teammateMailbox loadable)', false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
}

section('(3) DISTINCT: two dispatches with DIFFERENT request_ids BOTH deliver')
const tmp3 = mkdtempSync(join(tmpdir(), 'hermes-dedup3-'))
process.env.MERCURY_CONFIG_DIR = tmp3
try {
  const mailbox = await import('../../src/utils/teammateMailbox.js')
  const a = busmod.buildDispatch('scribe', 'distinct work A', { title: 'A' })
  const b = busmod.buildDispatch('scribe', 'distinct work B', { title: 'B' })
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: busmod.serializeScribeEnvelope(a), timestamp: new Date().toISOString() }, 'scribe')
  await mailbox.writeToMailbox('implementer', { from: 'scribe', text: busmod.serializeScribeEnvelope(b), timestamp: new Date().toISOString() }, 'scribe')
  const replies3: string[] = []
  const roster3 = { reply: async (_short: string, text: string) => { replies3.push(text); return true } }
  await bridge.drainScribeDispatches(roster3, { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
  check('both distinct dispatches deliver (dedup never drops legitimate work)', replies3.length === 2, `got ${replies3.length}`)
  check('A delivered', replies3.some(t => t.includes('distinct work A')))
  check('B delivered', replies3.some(t => t.includes('distinct work B')))
} catch (e) {
  check('distinct test ran (teammateMailbox loadable)', false, String(e).split('\n')[0])
} finally {
  delete process.env.MERCURY_CONFIG_DIR
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ENVELOPE-DEDUP PROOFS PASS')
else console.log(`❌ ${failures} ENVELOPE-DEDUP PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
