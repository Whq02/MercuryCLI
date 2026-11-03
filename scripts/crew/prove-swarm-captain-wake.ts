import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { open } from '../../src/services/crewBoard/store.ts'
import type { BoardPost, BoardPrincipal } from '../../src/services/crewBoard/contracts.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'captain-delivery-'))
const kinds = ['ask', 'blocker', 'result', 'answer', 'correction'] as const
const routes = ['own-label', 'outside', 'named', 'id', 'label', 'broadcast', 'self', 'lead', 'member'] as const
const selected = process.argv.indexOf('--case')
const only = selected < 0 ? undefined : process.argv[selected + 1]
assert(selected < 0 || only, '--case needs a case name')
let checks = 0
for (const kind of kinds) for (const route of routes) {
  const sessionId = `${kind}-${route}`
  if (only && only !== sessionId) continue
  let now = 0
  const board = open(join(home, `${sessionId}.sqlite`), sessionId, () => now += 15000)
  const seat = (agentId: string, name: string, team?: string): BoardPrincipal => ({ author: { sessionId, agentId, executionId: 'run' }, name, team })
  const main = seat('main', 'main')
  const captain = seat('captain-id', 'Captain', 'engine')
  const member = seat('member-id', 'Member', 'engine')
  const outside = seat('outside-id', 'Outside', 'view')
  const sender = route === 'self' ? captain : route === 'own-label' ? member : route === 'lead' ? main : outside
  const addresses = route === 'named' ? ['Captain'] : route === 'id' ? ['captain-id'] : route === 'label' || route === 'lead' ? ['engine'] : route === 'broadcast' ? ['all'] : route === 'member' ? ['member-id'] : []
  const text = `${sessionId}: ${'The entire finding reaches the captain. '.repeat(80)}END`
  try {
    for (const principal of [main, captain, member, outside]) board.enroll(principal)
    assert(board.assignCaptain(main, 'engine', 'captain-id').ok)
    let parent: string | undefined
    if (kind === 'answer' || kind === 'correction') {
      const seeded = board.post(sender, { clientOpId: 'seed', kind: kind === 'answer' ? 'ask' : 'result', text: 'The earlier post by this author.' })
      assert(seeded.ok)
      parent = seeded.eventId
    }
    const prior = board.boundary(captain, new Set())
    if (prior) board.presented(captain, prior.eventIds, 'fixture-ready')
    const input: BoardPost = { clientOpId: 'finding', kind, text, to: addresses, ...(kind === 'answer' ? { replyTo: parent } : {}), ...(kind === 'correction' ? { corrects: parent } : {}) }
    const posted = board.post(sender, input)
    assert(posted.ok)
    const packet = board.boundary(captain, new Set())
    const directed = ['named', 'id', 'label', 'broadcast', 'lead'].includes(route)
    const incoming = route === 'member' && (kind === 'ask' || kind === 'blocker')
    const selected = route !== 'self'
    assert.equal(packet?.text.includes(text) ?? false, selected, `${sessionId}: whole-body delivery`)
    assert.equal(packet?.eventIds.includes(posted.eventId) ?? false, selected, `${sessionId}: delivery selection`)
    const saved = board.view().events.find(event => event.eventId === posted.eventId)!
    assert.deepEqual(saved.addresses, addresses)
    if (route === 'member') assert(!saved.mentions.includes(captain.author.agentId), 'captain fanout is not an explicit mention')
    if (packet) {
      assert.equal(JSON.stringify(board.boundary(captain, new Set())), JSON.stringify(packet))
      board.presented(captain, packet.eventIds, 'captain-boundary')
      assert(!board.boundary(captain, new Set())?.eventIds.includes(posted.eventId))
    }
    assert.equal(board.view().peerTurns, 0, 'a live boundary never starts a second execution')
    checks++
    console.log(`PASS ${sessionId}`)
  } finally { board.close() }
}
if (!only || only === 'owner-member') {
  const board = open(join(home, 'owner-member.sqlite'), 'owner-member')
  const seat = (agentId: string, team?: string): BoardPrincipal => ({ author: { sessionId: 'owner-member', agentId, executionId: 'run' }, name: agentId, team })
  const main = seat('main'), captain = seat('captain', 'engine'), member = seat('member', 'engine')
  try {
    for (const principal of [main, captain, member]) board.enroll(principal)
    assert(board.assignCaptain(main, 'engine', 'captain').ok)
    const prior = board.boundary(captain, new Set())
    if (prior) board.presented(captain, prior.eventIds, 'fixture-ready')
    const text = 'Only the selected member and main receive this owner post.'
    const posted = board.postOwner(main, { clientOpId: 'direct-owner', channel: 'whisper', target: 'member', text })
    assert(posted.ok)
    assert.deepEqual([...posted.recipients].sort(), ['main', 'member'])
    assert(!board.boundary(captain, new Set())?.eventIds.includes(posted.eventId))
    assert(board.boundary(member, new Set())?.text.includes(text))
    assert(board.boundary(main, new Set())?.text.includes(text))
    assert.equal(board.view().peerTurns, 0)
    checks++
    console.log('PASS owner-member')
  } finally { board.close() }
}
if (!only || only === 'standing') {
  let now = 0, serial = 0
  const path = join(home, 'standing.sqlite')
  const board = open(path, 'standing', () => now += 15000)
  const seat = (agentId: string, team?: string): BoardPrincipal => ({ author: { sessionId: 'standing', agentId, executionId: 'first' }, name: agentId, team })
  const main = seat('main'), member = seat('member', 'engine'), replacement = seat('replacement', 'engine'), outside = seat('outside', 'view')
  let captain = seat('captain', 'engine')
  const post = (author: BoardPrincipal, text: string, to: string[] = []) => {
    const receipt = board.post(author, { clientOpId: `post-${++serial}`, kind: 'result', text, to })
    assert(receipt.ok)
    return receipt
  }
  const arm = (agent: string) => board.seats().find(row => row.agent === agent)?.wait
  try {
    for (const principal of [main, captain, member, replacement, outside]) board.enroll(principal)
    assert(board.assignCaptain(main, 'engine', 'captain').ok)
    assert.equal(arm('captain')?.standing, true)
    const before = post(member, 'Traffic before the first parking.')
    assert.equal(board.pendingWakes().length, 0)
    const seq = board.view().snapshot
    let changes = 0
    const unwatch = board.subscribe(() => { changes++ })
    board.settle(captain)
    assert.equal(board.pendingWakes().length, 0)
    assert.deepEqual(board.complete(captain, 'completed'), { kind: 'parked', event: 'team engine posts' })
    assert(changes > 0, 'parking publishes even without a new event')
    unwatch()
    assert.equal(board.view().snapshot, seq)
    assert.equal(arm('captain')?.seq, before.seq)
    assert.equal(board.pendingWakes().length, 0, 'old traffic cannot satisfy the new parking arm')
    post(member, 'A broadcast is not a wake.', ['all'])
    post(captain, 'A captain never wakes itself.')
    assert.equal(board.pendingWakes().length, 0)
    const trigger = post(member, 'FIRST-STANDING-WAKE')
    const wake = board.pendingWakes().find(row => row.agent === 'captain')!
    assert.equal(wake.eventId, trigger.eventId)
    assert.throws(() => board.claimWake(member, wake), /Only the lead/)
    const competing = open(path, 'standing')
    let claim
    try {
      const same = competing.pendingWakes().find(row => row.agent === 'captain')!
      claim = board.claimWake(main, wake)
      assert(claim)
      assert.equal(competing.claimWake(main, same), null)
    } finally { competing.close() }
    assert.equal(board.seats().find(row => row.agent === 'captain')?.state, 'parked')
    const packet = board.wakePacket(main, claim)!
    assert(packet.eventIds.includes(trigger.eventId))
    assert.equal(packet.text.split('FIRST-STANDING-WAKE').length, 2)
    captain = { ...captain, author: { ...captain.author, executionId: 'second' } }
    board.enroll(captain)
    board.admitWake(main, claim)
    board.admitWake(main, claim)
    assert.equal(board.view().peerTurns, 1)
    board.presented(captain, packet.eventIds, 'first-wake')
    assert.equal(arm('captain'), undefined)
    post(member, 'Unread traffic during the resumed turn.')
    const secondSeq = board.view().snapshot
    assert.deepEqual(board.complete(captain, 'completed'), { kind: 'parked', event: 'team engine posts' })
    assert.equal(arm('captain')?.standing, true)
    assert.equal(arm('captain')?.seq, secondSeq)
    assert.equal(board.pendingWakes().length, 0)
    const secondTrigger = post(member, 'SECOND-STANDING-WAKE')
    const secondWake = board.pendingWakes().find(row => row.agent === 'captain')!
    assert.equal(secondWake.eventId, secondTrigger.eventId)
    assert(secondWake.version > wake.version)
    assert(board.assignCaptain(main, 'engine', 'replacement').ok)
    assert.equal(arm('captain'), undefined)
    assert.equal(board.claimWake(main, secondWake), null)
    assert.equal(arm('replacement')?.standing, true)
    board.complete(replacement, 'completed')
    const next = board.post(outside, { clientOpId: 'new-captain', kind: 'ask', text: 'NEW-CAPTAIN-WAKE', to: ['member'] })
    assert(next.ok)
    assert.deepEqual(board.pendingWakes().map(row => [row.agent, row.eventId]), [['replacement', next.eventId]])
    const saved = board.view().events.find(row => row.eventId === next.eventId)!
    assert.deepEqual(saved.addresses, ['member'])
    assert.deepEqual(saved.mentions, ['member'])
    assert.equal(board.view().peerTurns, 1, 'a pending standing wake is not another execution')
    checks++
    console.log('PASS standing')
  } finally { board.close() }
}
assert(checks > 0, `unknown case: ${only}`)
console.log(`${checks} captain delivery and standing cases passed`)
