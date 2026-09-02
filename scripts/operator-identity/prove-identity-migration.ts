#!/usr/bin/env bun
// ============================================================================
//  scripts/operator-identity/prove-identity-migration.ts — legacy-keyed
//  records under the keyed identity (ledger L27 item 7; the one unforgivable
//  bug is an orphaned record). The records that OUTLIVE the retired
//  multiplayer estate — the crew conversations store — get the real one-shot
//  re-key. (The room-recognition pins retired with the room estate the
//  retirement deleted; recognition of legacy PRINCIPAL IDS stays the identity
//  module's own law, pinned by prove-operator-identity.)
//
//  The pins:
//    · the CONVERSATIONS STORE re-keys participants/actors/cursor keys in
//      one mutation, cursors merge to the FURTHEST position, a second run
//      moves zero;
//    · the crew boot wires the re-key BEFORE the main mint (source-pinned).
//
//  Hermetic: sweep-then-pin a scratch home BEFORE any src import.
//  Run:  ~/.bun/bin/bun run scripts/operator-identity/prove-identity-migration.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  delete process.env[name]
}
const HOME = mkdtempSync(join(tmpdir(), 'opmig-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.USER = 'opmig-tester'

const identity = await import('../../src/substrate/identity/identity.js')
const conversations = await import('../../src/services/crew/conversations.js')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 40s (an await never resolved)')
  process.exit(1)
}, 40000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const legacyId = identity.legacyOperatorPrincipalId()
const keyed = identity.operatorPrincipal()

console.log('============================================================')
console.log(' operator identity — legacy records under the keyed identity')
console.log('============================================================')

check('the keyed id differs from the legacy id (recognition has work)', keyed.id !== legacyId)

// ---------------------------------------------------------------------------
section('(1) the conversations store re-keys in one mutation (it OUTLIVES the estate)')
{
  const crewDir = mkdtempSync(join(tmpdir(), 'opmig-crew-'))
  await conversations.mintConversation({
    kind: 'main',
    title: 'Main session',
    participants: [{ kind: 'operator', principalId: legacyId }],
    adoptId: conversations.MAIN_CONVERSATION_ID,
    dir: crewDir,
  })
  await conversations.appendConversationEvent(
    conversations.MAIN_CONVERSATION_ID,
    { kind: 'question', ref: 'q-1', label: 'asked', requiresResolution: true, actor: { kind: 'operator', principalId: legacyId } },
    { dir: crewDir },
  )
  await conversations.commitReadCursor(legacyId, conversations.MAIN_CONVERSATION_ID, 3, { dir: crewDir })
  await conversations.commitReadCursor(keyed.id, conversations.MAIN_CONVERSATION_ID, 1, { dir: crewDir })

  const moved = await conversations.rekeyOperatorRecords([legacyId], keyed.id, { dir: crewDir })
  check('the re-key reports its moves', moved > 0, String(moved))
  const cv = await conversations.conversationOf(conversations.MAIN_CONVERSATION_ID, { dir: crewDir })
  check('participants carry the keyed id', cv !== null && cv.participants.every(p => (p as { principalId?: string }).principalId !== legacyId) && cv.participants.some(p => (p as { principalId?: string }).principalId === keyed.id))
  check('event actors carry the keyed id', cv !== null && cv.events.every(e => (e.actor as { principalId?: string } | undefined)?.principalId !== legacyId))
  check('the cursor moved and MERGED to the furthest position', (await conversations.readCursorOf(keyed.id, conversations.MAIN_CONVERSATION_ID, { dir: crewDir })) === 3)
  check('no cursor remains under the legacy id', (await conversations.listReadCursors(legacyId, { dir: crewDir })).size === 0)
  check('a second run moves ZERO (one shot)', (await conversations.rekeyOperatorRecords([legacyId], keyed.id, { dir: crewDir })) === 0)
}

// ---------------------------------------------------------------------------
section('(2) the crew boot wires the re-key before the main mint (source-pinned)')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const crew = readFileSync(join(ROOT, 'src/services/crew/identity.ts'), 'utf8')
  check('the crew boot re-keys the conversations store before the main mint', crew.includes('rekeyOperatorRecords') && crew.indexOf('rekeyOperatorRecords') < crew.indexOf('main conversation mint'))
}

console.log(failures === 0 ? '\n ✅ LEGACY RECORDS PROVEN UNDER THE KEYED IDENTITY' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
