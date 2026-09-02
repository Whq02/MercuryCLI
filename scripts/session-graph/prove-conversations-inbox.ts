#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-conversations-inbox.ts — the M5 conversation
//  identity + inbox laws.
//
//    §1 identity          — mint/adopt; side threads get NEW ids with parent
//                           lineage; a deliberate open reuses the id
//    §2 lineage           — branch/handoff records BOTH sides; no id changes;
//                           no event moves between conversations
//    §3 events + cursors  — monotonic seq across ring eviction; cursor
//                           commits exact + never rewinds; per-operator
//    §4 the comparator    — EXHAUSTIVE: bucket order beats priority beats
//                           unresolved age beats recency beats id; recency
//                           can never outrank an older question
//    §5 bucket derivation — owner-fact events only; silence never stalls;
//                           completion collapse is deterministic
//    §6 the opening law   — oldest unread-or-unresolved, never newest
//    §7 bounded honesty   — unread counts survive ring eviction (seq
//                           distance, not retained rows); explicit priority
//                           is settable and clears
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const conv = await import('../../src/services/crew/conversations.ts')
const inbox = await import('../../src/services/crew/inbox.ts')
type ConversationV1 = import('../../src/services/crew/conversations.ts').ConversationV1
type InboxRowV1 = import('../../src/services/crew/inbox.ts').InboxRowV1

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-conv-')))
const OP = 'op-test-operator'
const MAIN_AGENT = { kind: 'agent' as const, agentId: 'cw-aaaaaaaaaaaa' as never }
const OPERATOR = { kind: 'operator' as const, principalId: OP }

t.section('§1 — conversation identity')
{
  const main = await conv.mintConversation({
    kind: 'main',
    title: 'the main thread',
    participants: [OPERATOR, MAIN_AGENT],
    dir,
  })
  t.check('a conversation mints with a cv- id', /^cv-/.test(main.conversationId))
  const side = await conv.mintConversation({
    kind: 'console-side',
    title: 'a side question',
    participants: [OPERATOR],
    parentConversationId: main.conversationId,
    dir,
  })
  t.check('a console side question gets a NEW id (never the parent id)', side.conversationId !== main.conversationId)
  t.check(
    'the side thread records parent lineage',
    side.lineage.some(l => l.kind === 'parent' && l.otherConversationId === main.conversationId),
  )
  const parent = await conv.conversationOf(main.conversationId, { dir })
  t.check(
    'the parent records the child edge (lineage is explicit both ways)',
    parent!.lineage.some(l => l.kind === 'parent' && l.otherConversationId === side.conversationId),
  )
  const reopened = await conv.mintConversation({
    kind: 'main',
    title: 'IGNORED — the thread exists',
    participants: [OPERATOR],
    adoptId: main.conversationId,
    dir,
  })
  t.check('a deliberate open of a KNOWN thread reuses its id and record', reopened.conversationId === main.conversationId && reopened.title === 'the main thread')
}

t.section('§2 — handoff links, never merges')
{
  const all = await conv.listConversations({ dir })
  const main = all.find(c => c.kind === 'main')!
  const side = all.find(c => c.kind === 'console-side')!
  await conv.appendConversationEvent(side.conversationId, { kind: 'message', label: 'side finding' }, { dir })
  const linked = await conv.linkConversation(side.conversationId, main.conversationId, 'handoff', {
    ref: 'receipt:msg-1',
    dir,
  })
  t.check('the handoff records', linked === true)
  const after = await conv.conversationOf(side.conversationId, { dir })
  const target = await conv.conversationOf(main.conversationId, { dir })
  t.check('the source keeps its id + transcript', after!.conversationId === side.conversationId && after!.events.length === 1)
  t.check('the target gained NO transcript events from the handoff', target!.events.length === 0)
  t.check(
    'both sides carry the handoff edge',
    after!.lineage.some(l => l.kind === 'handoff' && l.direction === 'from') &&
      target!.lineage.some(l => l.kind === 'handoff' && l.direction === 'to'),
  )
}

t.section('§3 — events + per-operator cursors')
{
  const all = await conv.listConversations({ dir })
  const main = all.find(c => c.kind === 'main')!
  const s1 = await conv.appendConversationEvent(main.conversationId, { kind: 'message', label: 'one' }, { dir })
  const s2 = await conv.appendConversationEvent(
    main.conversationId,
    { kind: 'question', label: 'need a decision', requiresResolution: true },
    { dir },
  )
  t.check('seqs are monotonic', s1 === 1 && s2 === 2)
  t.check('the fresh cursor reads 0', (await conv.readCursorOf(OP, main.conversationId, { dir })) === 0)
  await conv.commitReadCursor(OP, main.conversationId, 1, { dir })
  t.check('the cursor commits the exact presented seq', (await conv.readCursorOf(OP, main.conversationId, { dir })) === 1)
  await conv.commitReadCursor(OP, main.conversationId, 0, { dir })
  t.check('a cursor never rewinds', (await conv.readCursorOf(OP, main.conversationId, { dir })) === 1)
  t.check('another operator keeps an independent cursor', (await conv.readCursorOf('op-other', main.conversationId, { dir })) === 0)
}

t.section('§4 — THE comparator, exhaustively')
{
  const row = (over: Partial<InboxRowV1>): InboxRowV1 => ({
    conversationId: 'cv-x' as never,
    bucket: 'working',
    title: 't',
    kind: 'work',
    unreadCount: 0,
    resumeSeq: null,
    unresolvedSinceMs: null,
    updatedAt: 1000,
    ...over,
  })
  const order = inbox.INBOX_BUCKET_ORDER
  t.check(
    'the bucket order is exactly needs-you → stalled → ready-to-review → working → completed',
    JSON.stringify(order) === JSON.stringify(['needs-you', 'stalled', 'ready-to-review', 'working', 'completed']),
  )
  for (let i = 0; i < order.length - 1; i++) {
    const hi = row({ bucket: order[i]!, updatedAt: 0, conversationId: 'cv-old' as never })
    const lo = row({ bucket: order[i + 1]!, updatedAt: 9_999_999, priority: 99, conversationId: 'cv-new' as never })
    t.check(
      `${order[i]} outranks ${order[i + 1]} regardless of priority/recency`,
      inbox.compareInboxRows(hi, lo) < 0,
    )
  }
  const prio = row({ priority: 5, conversationId: 'cv-a' as never })
  const noPrio = row({ updatedAt: 9_999_999, conversationId: 'cv-b' as never })
  t.check('explicit priority beats recency inside a bucket', inbox.compareInboxRows(prio, noPrio) < 0)
  const oldQ = row({ unresolvedSinceMs: 100, updatedAt: 0, conversationId: 'cv-oldq' as never })
  const newNoise = row({ unresolvedSinceMs: 90_000, updatedAt: 9_999_999, conversationId: 'cv-noise' as never })
  t.check('NEW NOISE CANNOT OUTRANK an older unresolved item (the anti-noise law)', inbox.compareInboxRows(oldQ, newNoise) < 0)
  const recA = row({ updatedAt: 2000, conversationId: 'cv-a' as never })
  const recB = row({ updatedAt: 1000, conversationId: 'cv-b' as never })
  t.check('recency is only the FINAL tie-break', inbox.compareInboxRows(recA, recB) < 0)
  const idA = row({ conversationId: 'cv-a' as never })
  const idB = row({ conversationId: 'cv-b' as never })
  t.check('the stable id closes the order (total, deterministic)', inbox.compareInboxRows(idA, idB) < 0 && inbox.compareInboxRows(idB, idA) > 0)
  t.check('the comparator is reflexively zero', inbox.compareInboxRows(idA, idA) === 0)
}

t.section('§5 — bucket derivation from owner-fact events')
{
  const mk = (events: Array<Partial<ConversationV1['events'][number]>>, over?: Partial<ConversationV1>): ConversationV1 => ({
    schema: 1,
    conversationId: 'cv-derive' as never,
    kind: 'work',
    title: 'w',
    participants: [],
    sessionRefs: [],
    workItemRefs: [],
    artifactRefs: [],
    lineage: [],
    lastEventSeq: events.length,
    events: events.map((e, i) => ({ seq: i + 1, kind: 'message', atMs: 1000 + i, ...e }) as never),
    createdAt: 0,
    updatedAt: 5000,
    ...over,
  })
  t.check(
    'an unresolved question reads needs-you',
    inbox.deriveInboxRow(mk([{ kind: 'question', requiresResolution: true }]), 0).bucket === 'needs-you',
  )
  t.check(
    'an unresolved failure reads stalled',
    inbox.deriveInboxRow(mk([{ kind: 'failure', requiresResolution: true }]), 0).bucket === 'stalled',
  )
  t.check(
    'an unresolved review-request reads ready-to-review',
    inbox.deriveInboxRow(mk([{ kind: 'review-request', requiresResolution: true }]), 0).bucket === 'ready-to-review',
  )
  t.check(
    'completion with everything resolved collapses to completed (deterministic)',
    inbox.deriveInboxRow(mk([{ kind: 'completion' }]), 0).bucket === 'completed',
  )
  t.check(
    'a resolved question no longer holds needs-you',
    inbox.deriveInboxRow(mk([{ kind: 'question', requiresResolution: true, resolvedAtMs: 2000 }, { kind: 'completion' }]), 0)
      .bucket === 'completed',
  )
  t.check(
    'plain activity reads working — SILENCE NEVER STALLS (no time-based transition)',
    inbox.deriveInboxRow(mk([{ kind: 'activity', atMs: 1 }]), 0).bucket === 'working',
  )
}

t.section('§6 — the opening law')
{
  const c: ConversationV1 = {
    schema: 1,
    conversationId: 'cv-open' as never,
    kind: 'work',
    title: 'o',
    participants: [],
    sessionRefs: [],
    workItemRefs: [],
    artifactRefs: [],
    lineage: [],
    lastEventSeq: 5,
    events: [
      { seq: 1, kind: 'message', atMs: 1 },
      { seq: 2, kind: 'question', atMs: 2, requiresResolution: true },
      { seq: 3, kind: 'message', atMs: 3 },
      { seq: 4, kind: 'message', atMs: 4 },
      { seq: 5, kind: 'message', atMs: 5 },
    ] as never,
    createdAt: 0,
    updatedAt: 5,
  }
  t.check('a read-to-3 cursor with an unresolved q@2 resumes at 2 (unresolved beats read state)', inbox.oldestUnresolvedOf(c, 3) === 2)
  t.check('a read-to-1 cursor resumes at 2 (oldest unread == oldest unresolved)', inbox.oldestUnresolvedOf(c, 1) === 2)
  t.check('fully read + resolved resumes null (nothing owed)', inbox.oldestUnresolvedOf({ ...c, events: c.events.map(e => ({ ...e, resolvedAtMs: 9 })) } as never, 5) === null)
  t.check('NEVER the newest: a fresh cursor resumes at seq 1, not 5', inbox.oldestUnresolvedOf({ ...c, events: c.events.map(e => ({ ...e, requiresResolution: false })) } as never, 0) === 1)
}

t.section('§7 — bounded honesty: eviction never falsifies the counts')
{
  const ringConv = await conv.mintConversation({
    kind: 'work',
    title: 'ring flood',
    participants: [OPERATOR],
    dir,
  })
  let lastSeq = 0
  for (let i = 0; i < 105; i++) {
    lastSeq = (await conv.appendConversationEvent(ringConv.conversationId, { kind: 'activity', label: `e${i}` }, { dir }))!
  }
  const flooded = await conv.conversationOf(ringConv.conversationId, { dir })
  t.check('the event ring is bounded while the seq counter never rewinds', flooded!.events.length === 100 && lastSeq === 105)
  const row = inbox.deriveInboxRow(flooded!, 0)
  t.check(
    'unreadCount is the SEQ DISTANCE, not the retained-row count (eviction cannot shrink what is owed)',
    row.unreadCount === 105,
    String(row.unreadCount),
  )
  const prioritySet = await conv.setConversationPriority(ringConv.conversationId, 7, { dir })
  const withPriority = await conv.conversationOf(ringConv.conversationId, { dir })
  t.check('explicit priority sets', prioritySet === true && withPriority!.priority === 7)
  await conv.setConversationPriority(ringConv.conversationId, undefined, { dir })
  const cleared = await conv.conversationOf(ringConv.conversationId, { dir })
  t.check('explicit priority clears', cleared!.priority === undefined)
}

t.finish('prove-conversations-inbox')
