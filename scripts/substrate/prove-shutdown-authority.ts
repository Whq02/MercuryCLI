#!/usr/bin/env bun

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

check('self-approval (envelope==body) ⇒ victim is the verified sender', v('alice', 'alice') === 'alice')
check('whitespace tolerated (still self)', v(' alice ', 'alice') === 'alice')

check('SPOOF: in-body from=bob, sender=alice ⇒ IGNORED (null)', v('alice', 'bob') === null)
check('cannot target another teammate by name via in-body from', v('attacker', 'victim') === null)

check('missing in-body from ⇒ bound to verified sender', v('alice', undefined) === 'alice')
check('empty in-body from ⇒ bound to verified sender', v('alice', '') === 'alice')

check('no verified envelope sender ⇒ IGNORED (null)', v('', 'alice') === null)
check('undefined envelope sender ⇒ IGNORED (null)', v(undefined, 'alice') === null)

console.log('\n' + '─'.repeat(76) + '\n shutdown_request sender binding — reject the lead-attributed forge')
const r = (env: string | undefined, from: unknown) =>
  resolveShutdownRequestSender(env, { from } as Parameters<typeof resolveShutdownRequestSender>[1])
check('legit lead request (envelope==body) ⇒ attributed to lead', r('team-lead', 'team-lead') === 'team-lead')
check('legit command-rank request (envelope==body) ⇒ attributed to sender', r('captain', 'captain') === 'captain')
check('SPOOF: body=team-lead, envelope=peer ⇒ IGNORED (null)', r('peer', 'team-lead') === null)
check('cannot impersonate any other directing actor', r('attacker', 'captain') === null)
check('honest peer request ⇒ attributed to the peer (not the lead)', r('peer', 'peer') === 'peer')
check('missing in-body from ⇒ bound to verified sender', r('team-lead', undefined) === 'team-lead')
check('no verified envelope sender ⇒ IGNORED (null)', r('', 'team-lead') === null)
check('undefined envelope sender ⇒ IGNORED (null)', r(undefined, 'team-lead') === null)

console.log('\n' + '─'.repeat(76) + '\n Q&A answer authority (#18) — only the addressee closes')
check('the addressee (to) closing ⇒ allowed', canAnswerCloseQuestion({ to: 'bob' }, 'bob') === true)
check('a NON-addressee answering ⇒ cannot close (no spoof-answer)', canAnswerCloseQuestion({ to: 'bob' }, 'carol') === false)
check('an already-answered question never re-closes', canAnswerCloseQuestion({ to: 'bob', answeredAt: '2026-01-01' }, 'bob') === false)
check('a question with no addressee cannot be closed', canAnswerCloseQuestion({ to: '' }, 'bob') === false)
check('whitespace tolerated on the addressee match', canAnswerCloseQuestion({ to: ' bob ' }, 'bob') === true)
check('case-insensitive addressee match (To:"Bob" closed by "bob")', canAnswerCloseQuestion({ to: 'Bob' }, 'bob') === true)
check('case-insensitive both ways ("bob" closed by "BOB")', canAnswerCloseQuestion({ to: 'bob' }, 'BOB') === true)
check('a different name still cannot close (case-insensitive is not any-name)', canAnswerCloseQuestion({ to: 'Bob' }, 'carol') === false)

console.log('\n— HB-0070: canDirect re-check on received shutdown_requests —')
const actor = (name: string) => resolveDirectActor(null, name, undefined)
check('lead → me: shutdown_request ALLOWED to surface', canDirect(actor('team-lead'), actor('me')).allowed === true)
check('peer → me: shutdown_request DENIED (the coord_say-injected bypass is gated)', canDirect(actor('peer'), actor('me')).allowed === false)
check('me → me: self-shutdown ALLOWED (an agent may request its own shutdown)', canDirect(actor('me'), actor('me')).allowed === true)
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
