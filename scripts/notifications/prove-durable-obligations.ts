#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-durable-obligations.ts — (core;
//  the durable half): durable needs-you obligations at the
//  crew-conversation owner. Subsumes repro-durable-obligations VERBATIM
//  (retired when the owner landed — the runner law forbids a passing repro
//  over an unmet row; flips only when the §7 notification dedup layer
//  proves no-duplicate-ALERTS on top of the no-duplicate-rows law here).
//
//  §1  the frozen owner surface (frozen verbatim).
//  §2  one question ⇒ one durable row; settlement exactly once.
//  §3  a changed re-raise updates IN PLACE (same id, revision bump).
//  §4  answer-vs-withdrawal race: deterministic winner, both attempts
//      preserved on the bounded ledger.
//  §5  durability: the row is real on disk (restart = reread).
//  §6  redirect moves the owner only; settled/unknown targets reject.
//  §7  per-destination emission/ack state is monotonic per revision.
//  §8  ordering (oldest ordinal first) + the per-principal filter.
//  §9  per-obligation storage: 120 ring events cannot evict an obligation.
//  §10 retention: settled rows bound; OPEN rows are never dropped.
//  §11 the attention bridge translation (pure): revision-keyed facts,
//      principal filter, exactly-once settled retraction.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
// Crew-touching proof hygiene (F-24): NEVER the operator's live crew world.
const root = scratchRoot('durable-obligations')
process.env.MERCURY_CREW_DIR = join(root, 'crew')

const obl = await import('../../src/services/crew/obligations.js')

t.section('§1 — the durable obligation owner exists at the crew-conversation owner')
t.check('src/services/crew/obligations.ts exists', obl != null, 'present')
for (const fn of ['upsertObligation', 'openObligations', 'resolveObligation'] as const) {
  t.check(`it exports ${fn}()`, typeof obl[fn] === 'function', 'present')
}

t.section('§2 — one question ⇒ one durable row; resolution settles exactly once')
{
  const row = await obl.upsertObligation({
    ref: 'obl-q1',
    sessionId: 'sess-a',
    question: 'Choose the schema migration order',
    owner: 'op',
  })
  const again = await obl.upsertObligation({
    ref: 'obl-q1',
    sessionId: 'sess-a',
    question: 'Choose the schema migration order',
    owner: 'op',
  })
  t.check('an idempotent re-raise answers the SAME obligationId', again.obligationId === row.obligationId && again.reraised === true, JSON.stringify(again))
  const openRows = await obl.openObligations({ sessionId: 'sess-a' })
  t.check('ONE open row', openRows.length === 1, `open=${openRows.length}`)
  t.check('an identical re-raise bumps NOTHING (idempotent, no revision churn)', again.revision === row.revision, `r${again.revision}`)
  const first = await obl.resolveObligation(row.obligationId, { kind: 'answered', by: 'op', answerRef: 'receipt:ans-1' })
  const second = await obl.resolveObligation(row.obligationId, { kind: 'answered' })
  t.check('resolution settles exactly once', first.settled === true && second.settled === false && second.status === 'answered', JSON.stringify({ first, second }))
  const settledRow = await obl.obligationOf(row.obligationId)
  t.check('the settlement carries the answer receipt (crew dispatch vocabulary)', settledRow?.settlement?.answerRef === 'receipt:ans-1', JSON.stringify(settledRow?.settlement))
}

t.section('§3 — a changed re-raise updates IN PLACE (never a second row)')
{
  const a = await obl.upsertObligation({ ref: 'obl-q2', sessionId: 'sess-a', question: 'v1?', owner: 'op' })
  const b = await obl.upsertObligation({ ref: 'obl-q2', sessionId: 'sess-a', question: 'v2 — clarified?', owner: 'op' })
  t.check('same id, bumped revision', b.obligationId === a.obligationId && b.revision === a.revision + 1, JSON.stringify(b))
  const open = await obl.openObligations({ sessionId: 'sess-a' })
  t.check('still ONE open row for the ref', open.filter(o => o.ref === 'obl-q2').length === 1, String(open.length))
  t.check('the row carries the updated question', open.find(o => o.ref === 'obl-q2')?.question === 'v2 — clarified?', 'updated')
  await obl.resolveObligation(a.obligationId, { kind: 'resolved' })
  const fresh = await obl.upsertObligation({ ref: 'obl-q2', sessionId: 'sess-a', question: 'a new question, reused ref', owner: 'op' })
  t.check('a SETTLED ref re-raise mints a FRESH obligation (new question, new row)', fresh.obligationId !== a.obligationId && fresh.reraised === false, JSON.stringify(fresh))
  await obl.resolveObligation(fresh.obligationId, { kind: 'withdrawn' })
}

t.section('§4 — answer racing withdrawal settles deterministically, both preserved')
{
  const row = await obl.upsertObligation({ ref: 'obl-race', sessionId: 'sess-a', question: 'race?', owner: 'op' })
  const [answer, withdrawal] = await Promise.all([
    obl.resolveObligation(row.obligationId, { kind: 'answered', by: 'answerer' }),
    obl.resolveObligation(row.obligationId, { kind: 'withdrawn', by: 'withdrawer' }),
  ])
  const settledCount = [answer, withdrawal].filter(r => r.settled).length
  t.check('EXACTLY one racer settles', settledCount === 1, JSON.stringify({ answer, withdrawal }))
  const final = await obl.obligationOf(row.obligationId)
  t.check('the final status is the winner’s (deterministic, terminal)', final?.status === (answer.settled ? 'answered' : 'withdrawn'), String(final?.status))
  t.check(
    'BOTH attempts are preserved on the ledger (the loser applied=false)',
    final?.settlementAttempts.length === 2 && final.settlementAttempts.filter(x => x.applied).length === 1,
    JSON.stringify(final?.settlementAttempts),
  )
}

t.section('§5 — the row is durable on disk (restart = reread)')
{
  const crewDir = join(root, 'crew')
  const files = readdirSync(crewDir).filter(f => f.startsWith('obligations-'))
  t.check('the obligations store exists on disk (per-project file)', files.length === 1, JSON.stringify(files))
  const raw = JSON.parse(readFileSync(join(crewDir, files[0]!), 'utf8')) as { obligations?: Record<string, { ref?: string; status?: string }> }
  const rows = Object.values(raw.obligations ?? {})
  t.check('the settled q1 row is durably present with its status', rows.some(r => r.ref === 'obl-q1' && r.status === 'answered'), `${rows.length} durable row(s)`)
}

t.section('§6 — redirect moves the OWNER only; stale targets reject')
{
  const row = await obl.upsertObligation({ ref: 'obl-redir', sessionId: 'sess-b', question: 'who owns this?', owner: 'alice' })
  const before = await obl.obligationOf(row.obligationId)
  const moved = await obl.redirectObligation(row.obligationId, 'bob', { by: 'alice' })
  const after = await obl.obligationOf(row.obligationId)
  t.check('redirect answers open + moves the owner', moved.redirected === true && after?.owner === 'bob', JSON.stringify(moved))
  t.check('identity and question unchanged; revision bumped', after?.obligationId === before?.obligationId && after?.question === before?.question && after !== null && before !== null && after.revision === before.revision + 1, `r${after?.revision}`)
  const unknown = await obl.redirectObligation('obl-nope', 'bob')
  t.check('an unknown target rejects with a receipt (never starts anything)', unknown.redirected === false && unknown.status === 'unknown', JSON.stringify(unknown))
  await obl.resolveObligation(row.obligationId, { kind: 'resolved' })
  const settled = await obl.redirectObligation(row.obligationId, 'carol')
  t.check('a settled target rejects with its standing status', settled.redirected === false && settled.status === 'resolved', JSON.stringify(settled))
}

t.section('§7 — per-destination emission/ack state (monotonic per revision)')
{
  const row = await obl.upsertObligation({ ref: 'obl-notify', sessionId: 'sess-b', question: 'notify me?', owner: 'op' })
  const e1 = await obl.noteObligationEmission(row.obligationId, 'host', row.revision)
  const e2 = await obl.noteObligationEmission(row.obligationId, 'host', row.revision)
  t.check('one emission per (destination, revision) — the second note refuses', e1 === true && e2 === false, JSON.stringify({ e1, e2 }))
  const ack = await obl.acknowledgeObligation(row.obligationId, 'host', row.revision)
  const ackAgain = await obl.acknowledgeObligation(row.obligationId, 'host', row.revision)
  t.check('acknowledgement is monotonic too', ack === true && ackAgain === false, JSON.stringify({ ack, ackAgain }))
  const after = await obl.obligationOf(row.obligationId)
  t.check(
    'the row carries emission AND ack state per destination (emission ≠ delivery — no delivered field anywhere)',
    after?.notifications['host']?.emittedRevision === row.revision &&
      after.notifications['host']?.acknowledgedRevision === row.revision &&
      !JSON.stringify(after.notifications).includes('delivered'),
    JSON.stringify(after?.notifications),
  )
  await obl.resolveObligation(row.obligationId, { kind: 'resolved' })
}

t.section('§8 — oldest-first ordering + the per-principal filter')
{
  const first = await obl.upsertObligation({ ref: 'obl-o1', sessionId: 'sess-c', question: 'first?', owner: 'op' })
  await obl.upsertObligation({ ref: 'obl-o2', sessionId: 'sess-c', question: 'second?', owner: 'op', principals: ['alice'] })
  const all = await obl.openObligations({ sessionId: 'sess-c' })
  t.check('open rows come oldest createdOrdinal first (§6.2)', all.length === 2 && all[0]?.ref === 'obl-o1' && all[0].createdOrdinal < all[1]!.createdOrdinal, JSON.stringify(all.map(o => o.ref)))
  const forBob = await obl.openObligations({ sessionId: 'sess-c', principal: 'bob' })
  t.check('the principal filter keeps unaddressed rows + drops foreign-addressed ones', forBob.length === 1 && forBob[0]?.ref === 'obl-o1', JSON.stringify(forBob.map(o => o.ref)))
  const forAlice = await obl.openObligations({ sessionId: 'sess-c', principal: 'alice' })
  t.check('an addressed principal sees both', forAlice.length === 2, String(forAlice.length))
  await obl.resolveObligation(first.obligationId, { kind: 'resolved' })
  for (const o of await obl.openObligations({ sessionId: 'sess-c' })) {
    await obl.resolveObligation(o.obligationId, { kind: 'resolved' })
  }
}

t.section('§9 — per-obligation storage: the conversation ring cannot evict it')
{
  const conv = await import('../../src/services/crew/conversations.js')
  const thread = await conv.mintConversation({ kind: 'work', title: 'ring-storm', participants: [] })
  const row = await obl.upsertObligation({
    ref: 'obl-ring',
    sessionId: 'sess-ring',
    conversationId: thread.conversationId,
    question: 'survive the ring?',
    owner: 'op',
  })
  for (let i = 0; i < 120; i++) {
    await conv.appendConversationEvent(thread.conversationId, { kind: 'activity', label: `noise-${i}` })
  }
  const after = await obl.obligationOf(row.obligationId)
  t.check('120 ring events later the obligation row is UNTOUCHED and open', after?.status === 'open' && after.question === 'survive the ring?', String(after?.status))
  await obl.resolveObligation(row.obligationId, { kind: 'resolved' })
}

t.section('§10 — retention: settled rows bound, OPEN rows never dropped')
{
  const keepOpen = await obl.upsertObligation({ ref: 'obl-keep-open', sessionId: 'sess-r', question: 'still here?', owner: 'op' })
  for (let i = 0; i < 210; i++) {
    const r = await obl.upsertObligation({ ref: `obl-churn-${i}`, sessionId: 'sess-r', question: `churn ${i}`, owner: 'op' })
    await obl.resolveObligation(r.obligationId, { kind: 'resolved' })
  }
  const all = await obl.listObligations()
  const settled = all.filter(o => o.status !== 'open')
  t.check('settled retention is bounded (≤200)', settled.length <= 200, String(settled.length))
  const stillOpen = await obl.obligationOf(keepOpen.obligationId)
  t.check('the OPEN row survived the churn (never dropped)', stillOpen?.status === 'open', String(stillOpen?.status))
  await obl.resolveObligation(keepOpen.obligationId, { kind: 'resolved' })
}

t.section('§11 — the attention bridge translation (pure; per-principal projection)')
{
  const bridge = await import('../../src/services/crew/obligationsBridge.js')
  bridge._resetObligationsBridgeForTesting()
  const mk = (id: string, over: Partial<import('../../src/services/crew/obligations.js').ObligationV1> = {}): import('../../src/services/crew/obligations.js').ObligationV1 => ({
    schema: 1,
    obligationId: id,
    ref: `ref-${id}`,
    sessionId: 'sess-x',
    question: `q-${id}`,
    principals: [],
    owner: 'op',
    status: 'open',
    createdOrdinal: 1,
    revision: 3,
    createdAtMs: 1000,
    updatedAtMs: 2000,
    settlementAttempts: [],
    notifications: {},
    ...over,
  })
  const facts = bridge.obligationFacts([mk('a'), mk('b', { principals: ['someone-else'] })], 'me', 5000)
  t.check('an open row projects ONE needs-you fact keyed by id + revision', facts.length === 1 && facts[0]?.subjectId === 'obligation:a' && facts[0].sourceEventId === 'obl:a:r3' && facts[0].bucket === 'needs-you', JSON.stringify(facts))
  t.check('a foreign-addressed row is filtered per principal (§6.1 projection)', !facts.some(f => f.subjectId === 'obligation:b'), 'filtered')
  const after = bridge.obligationFacts([], 'me', 6000)
  t.check('a row that left the open set retracts exactly once (completed fact)', after.length === 1 && after[0]?.subjectId === 'obligation:a' && after[0].bucket === 'completed', JSON.stringify(after))
  const again = bridge.obligationFacts([], 'me', 7000)
  t.check('the retraction never repeats', again.length === 0, String(again.length))
  bridge._resetObligationsBridgeForTesting()
}

t.section('§12 — the PRODUCTION raiser: crew dispatch wires the durable twin')
{
  const conv = await import('../../src/services/crew/conversations.js')
  const disp = await import('../../src/services/crew/dispatch.js')
  const thread = await conv.mintConversation({ kind: 'work', title: 'wire', participants: [] })
  const receipt = await disp.dispatchToAgent({
    clientMessageId: 'cmid-wire-1',
    sourceConversationId: thread.conversationId,
    requestedAddress: { agentId: 'agent-missing' as never },
    requestedDisposition: 'hold-next',
    instruction: 'do the thing',
    attachments: [],
  })
  t.check('the fixture dispatch is honestly not-delivered', receipt.state === 'not-delivered', receipt.state)
  // The raise lands in the SWITCHBOARD scope — the one cwd-independent file
  // every consumer reads (the attention bridge, the concourse, the host
  // signals); the ambient cwd-hashed file must stay empty of it.
  const raised = (await obl.openObligations({ scope: 'switchboard' })).find(o => o.ref === 'receipt:cmid-wire-1')
  t.check(
    'the failed dispatch RAISED the durable obligation in the switchboard scope (the ring twin; the receipt is the authority, never prose)',
    raised !== undefined && raised.conversationId === thread.conversationId && /not-delivered/.test(raised.question),
    raised ? raised.question : 'absent',
  )
  const ambientLeak = (await obl.openObligations()).find(o => o.ref === 'receipt:cmid-wire-1')
  t.check('the ambient cwd-hashed file carries no copy of it', ambientLeak === undefined)
  const settledViaRef = await obl.resolveObligationByRef('receipt:cmid-wire-1', { kind: 'resolved', answerRef: 'receipt:cmid-wire-1', scope: 'switchboard' })
  t.check('the recovery seam settles by REF (the resolveEventByRef twin)', settledViaRef.settled === true, JSON.stringify(settledViaRef))
  const src = readFileSync('src/services/crew/dispatch.ts', 'utf8')
  t.check(
    'the delivered-recovery path settles the obligation beside the conversation event (structural symmetry)',
    /resolveObligationByRef\(ref/.test(src) && /resolveEventByRef\(/.test(src),
    'both recovery twins present',
  )
}

t.finish('prove-durable-obligations')
