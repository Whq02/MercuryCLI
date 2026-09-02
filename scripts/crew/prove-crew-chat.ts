#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-crew-chat.ts
//  PROOF: the chat model — one teammate's transcript is the MERGE of its own
//  inbox (operator → teammate) and the shared team-lead inbox (teammate →
//  operator), time-ordered; unread badges are PER-CHAT on the shared inbox
//  (markMessagesFromAsRead: opening @atlas's chat never flattens @beacon's
//  badge — the mailbox-TOCTOU lesson, scoped by sender). REAL mailbox files
//  under a scratch MERCURY_CONFIG_DIR.
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-crew-chat.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'crew-chat-'))
process.env.MERCURY_CONFIG_DIR = scratch
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const cs = (await import('../../src/daemon/crewSpawn.js')) as typeof import('../../src/daemon/crewSpawn.js')
const cc = (await import('../../src/utils/crew/crewClient.js')) as typeof import('../../src/utils/crew/crewClient.js')
const { writeToMailbox, readMailbox } = await import('../../src/utils/teammateMailbox.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

console.log('============================================================')
console.log(' Crew chat model (merge · unread isolation) — proof')
console.log('============================================================')

section('seed: two durable chat identities + traffic in both directions')
await cs.ensureCrewTeamMember('atlas', 'sonnet', scratch)
await cs.ensureCrewTeamMember('beacon', 'opus', scratch)
const members = await cc.listCrewMembers()
check('listCrewMembers: both, lead excluded', members.length === 2 && members.some(m => m.name === 'atlas') && members.some(m => m.name === 'beacon') && !members.some(m => m.name === 'team-lead'))
check('member models from the closed table', members.find(m => m.name === 'atlas')?.model === 'claude-sonnet-5' && members.find(m => m.name === 'beacon')?.model === 'claude-opus-5')

check('sendCrewMessage writes the operator frame', (await cc.sendCrewMessage('atlas', '  hi atlas  ')) === true)
check('blank message refused (no ghost writes)', (await cc.sendCrewMessage('atlas', '   ')) === false)
const atlasInbox = await readMailbox('atlas', 'crew')
check('teammate inbox: one frame, from team-lead, trimmed', atlasInbox.length === 1 && atlasInbox[0]!.from === 'team-lead' && atlasInbox[0]!.text === 'hi atlas')

// Teammate replies land in the SHARED team-lead inbox (the child's
// SendMessage path) — seed both teammates' replies with later timestamps.
const later = (ms: number) => new Date(Date.now() + ms).toISOString()
await writeToMailbox('team-lead', { from: 'atlas', text: 'reply from atlas', timestamp: later(5000) }, 'crew')
await writeToMailbox('team-lead', { from: 'beacon', text: 'reply from beacon', timestamp: later(6000) }, 'crew')

section('readCrewChat — the merged, time-ordered transcript')
const chat = await cc.readCrewChat('atlas')
check('exactly the atlas rows (beacon excluded)', chat.length === 2)
check('row 1: operator out-frame', chat[0]?.dir === 'out' && chat[0]?.text === 'hi atlas')
check('row 2: atlas reply, ordered after', chat[1]?.dir === 'in' && chat[1]?.text === 'reply from atlas')
check('reply starts unread', chat[1]?.read === false)

section('per-chat unread — opening one chat NEVER flattens another badge')
const before = await cc.crewUnreadCounts()
check('badges: atlas 1 · beacon 1', (before.get('atlas') ?? 0) === 1 && (before.get('beacon') ?? 0) === 1)
await cc.markCrewChatRead('atlas')
const after = await cc.crewUnreadCounts()
check('after viewing atlas: atlas 0', (after.get('atlas') ?? 0) === 0)
check("beacon's badge SURVIVES (the isolation contract)", (after.get('beacon') ?? 0) === 1)
const leadInbox = await readMailbox('team-lead', 'crew')
check('underlying flags: atlas read, beacon unread', leadInbox.find(m => m.from === 'atlas')?.read === true && !leadInbox.find(m => m.from === 'beacon')?.read)
const chatAfter = await cc.readCrewChat('atlas')
check('transcript reflects the read flag', chatAfter[1]?.read === true)

section('store handles for live board subscriptions')
const stores = cc.crewChatStores('atlas')
check('outbox + leadInbox stores expose subscribe()', typeof stores.outbox.subscribe === 'function' && typeof stores.leadInbox.subscribe === 'function')

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} CREW CHAT PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL CREW CHAT PROOFS PASS')
