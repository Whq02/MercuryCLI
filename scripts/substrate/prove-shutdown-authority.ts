#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-shutdown-authority.ts
//  PROOF: a shutdown_approved is bound to the VERIFIED envelope sender, so a
//  teammate can only approve its OWN shutdown — it cannot remove/kill another
//  teammate by spoofing the in-body `from` (review #16/#17). Exercised against
//  the REAL resolveShutdownApprovedVictim used at every act-point (useInboxPoller,
//  attachments, cli/print).
// ============================================================================

import {
  resolveShutdownApprovedVictim,
  resolveShutdownRequestSender,
} from '../../src/utils/teammateMailbox.js'
import { canAnswerCloseQuestion, canDirect, resolveDirectActor } from '../../src/utils/swarm/sendMessageGovernance.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const v = (env: string | undefined, from: unknown) =>
  resolveShutdownApprovedVictim(env, { from } as Parameters<typeof resolveShutdownApprovedVictim>[1])

console.log('============================================================')
console.log(' shutdown_approved authority binding — proof')
console.log('============================================================\n')

// Legitimate self-approval (the SendMessage approve path stamps from = own name,
// envelope from = own name) ⇒ honored.
check('self-approval (envelope==body) ⇒ victim is the verified sender', v('alice', 'alice') === 'alice')
check('whitespace tolerated (still self)', v(' alice ', 'alice') === 'alice')

// The attack: a teammate sends shutdown_approved claiming from=another agent.
check('SPOOF: in-body from=bob, sender=alice ⇒ IGNORED (null)', v('alice', 'bob') === null)
check('cannot target another teammate by name via in-body from', v('attacker', 'victim') === null)

// No in-body from ⇒ bind to the verified sender (the message is self-attested).
check('missing in-body from ⇒ bound to verified sender', v('alice', undefined) === 'alice')
check('empty in-body from ⇒ bound to verified sender', v('alice', '') === 'alice')

// No verified envelope sender ⇒ refuse (can't trust an unsourced shutdown).
check('no verified envelope sender ⇒ IGNORED (null)', v('', 'alice') === null)
check('undefined envelope sender ⇒ IGNORED (null)', v(undefined, 'alice') === null)

// ── shutdown_REQUEST: attribute to the verified envelope sender, reject spoofs ─
console.log('\n' + '─'.repeat(76) + '\n shutdown_request sender binding — reject the lead-attributed forge')
const r = (env: string | undefined, from: unknown) =>
  resolveShutdownRequestSender(env, { from } as Parameters<typeof resolveShutdownRequestSender>[1])
// Legitimate: producers always stamp in-body from === envelope from.
check('legit lead request (envelope==body) ⇒ attributed to lead', r('team-lead', 'team-lead') === 'team-lead')
check('legit command-rank request (envelope==body) ⇒ attributed to sender', r('captain', 'captain') === 'captain')
// The attack: a peer plain-text-crafts a request claiming from=team-lead.
check('SPOOF: body=team-lead, envelope=peer ⇒ IGNORED (null)', r('peer', 'team-lead') === null)
check('cannot impersonate any other directing actor', r('attacker', 'captain') === null)
// Honest peer request (body==envelope) is surfaced truthfully — model applies doctrine.
check('honest peer request ⇒ attributed to the peer (not the lead)', r('peer', 'peer') === 'peer')
// Missing in-body from ⇒ bind to the verified envelope sender.
check('missing in-body from ⇒ bound to verified sender', r('team-lead', undefined) === 'team-lead')
// No verified envelope sender ⇒ refuse an unsourced directive.
check('no verified envelope sender ⇒ IGNORED (null)', r('', 'team-lead') === null)
check('undefined envelope sender ⇒ IGNORED (null)', r(undefined, 'team-lead') === null)

// ── #18 — Q&A: only the ADDRESSEE can close a question ───────────────────────
console.log('\n' + '─'.repeat(76) + '\n Q&A answer authority (#18) — only the addressee closes')
check('the addressee (to) closing ⇒ allowed', canAnswerCloseQuestion({ to: 'bob' }, 'bob') === true)
check('a NON-addressee answering ⇒ cannot close (no spoof-answer)', canAnswerCloseQuestion({ to: 'bob' }, 'carol') === false)
check('an already-answered question never re-closes', canAnswerCloseQuestion({ to: 'bob', answeredAt: '2026-01-01' }, 'bob') === false)
check('a question with no addressee cannot be closed', canAnswerCloseQuestion({ to: '' }, 'bob') === false)
check('whitespace tolerated on the addressee match', canAnswerCloseQuestion({ to: ' bob ' }, 'bob') === true)
check('case-insensitive addressee match (To:"Bob" closed by "bob")', canAnswerCloseQuestion({ to: 'Bob' }, 'bob') === true)
check('case-insensitive both ways ("bob" closed by "BOB")', canAnswerCloseQuestion({ to: 'bob' }, 'BOB') === true)
check('a different name still cannot close (case-insensitive is not any-name)', canAnswerCloseQuestion({ to: 'Bob' }, 'carol') === false)

// ──: AUTHORITY (canDirect) re-checked on RECEIVE ────────────────────
// The anti-spoof above attributes an honest peer request to the peer (r('peer',
// 'peer')==='peer'). But coord_say writes verbatim message text with NO send-side
// canDirect gate, so a non-lead could surface an approvable shutdown directive.
// useInboxPoller now re-applies canDirect(verifiedSender, self) on received
// shutdown_requests — a non-lead's request is dropped.
console.log('\n— HB-0070: canDirect re-check on received shutdown_requests —')
const actor = (name: string) => resolveDirectActor(null, name, undefined) // flat (default) authority
check('lead → me: shutdown_request ALLOWED to surface', canDirect(actor('team-lead'), actor('me')).allowed === true)
check('peer → me: shutdown_request DENIED (the coord_say-injected bypass is gated)', canDirect(actor('peer'), actor('me')).allowed === false)
check('me → me: self-shutdown ALLOWED (an agent may request its own shutdown)', canDirect(actor('me'), actor('me')).allowed === true)
// Wiring: the receive path imports + applies the SAME helpers as the send path,
// and resolveDirectActor is the SHARED one (no duplicated authority logic).
const poller = readFileSync(join(import.meta.dir, '..', '..', 'src', 'hooks', 'useInboxPoller.ts'), 'utf-8')
check('useInboxPoller imports canDirect + resolveDirectActor from sendMessageGovernance', /import \{ canDirect, resolveDirectActor \} from '\.\.\/utils\/swarm\/sendMessageGovernance\.js'/.test(poller))
check('useInboxPoller gates received shutdown_requests on canDirect(verifiedFrom, self)', /canDirect\(\s*resolveDirectActor\(sdTeamFile, verifiedFrom, sdLeadId\),\s*resolveDirectActor\(sdTeamFile, sdSelf, sdLeadId\),\s*\)/.test(poller))
const sendTool = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'SendMessageTool', 'SendMessageTool.ts'), 'utf-8')
check('SendMessageTool imports the SHARED resolveDirectActor (no local duplicate)', /resolveDirectActor,/.test(sendTool) && !/function resolveDirectActor\(/.test(sendTool))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SHUTDOWN-AUTHORITY PROOFS PASS')
else console.log(`❌ ${failures} SHUTDOWN-AUTHORITY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
