#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-continuity-handoffs.ts — the M6 Console/
//  Minerva/shelf continuity laws.
//
//  Hermetic: every store rides an mkdtemp dir seam.
//
//    §1 console identity   — an ask mints a NEW console-side conversation
//                            with parent lineage; outcomes land on ITS
//                            events (answered → completed; failed → stalled)
//    §2 the handoff law    — both sides gain the edge; NO id changes; NO
//                            transcript moves; self/unknown handoffs refuse
//    §3 Minerva staging    — original AND refined side by side + provenance;
//                            staging dispatches nothing; the receipt ref
//                            lands only via markStagedDispatched; dismissal
//                            touches ONLY the draft; settled-first eviction
//    §4 per-conversation drafts — conversationScope keys distinct documents
//                            (three surfaces share the owner, never a shelf)
//    §5 the ONE target picker — rows key on stable ids; dispatchable only
//                            for REAL endpoints (never a guaranteed refusal)
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-continuity-')))
const dir = join(scratch, 'store')

const conv = await import('../../src/services/crew/conversations.ts')
const consoleHandoff = await import('../../src/services/crew/consoleHandoff.ts')
const minerva = await import('../../src/services/crew/minervaHandoff.ts')
const inbox = await import('../../src/services/crew/inbox.ts')
const composer = await import('../../src/input-core/composer-document.ts')
const picker = await import('../../src/services/crew/targetPicker.ts')

const OPERATOR = { kind: 'operator' as const, principalId: 'op-continuity' }

t.section('§1 — console asks mint their OWN conversation identity')
{
  const main = await conv.mintConversation({
    kind: 'main',
    title: 'main',
    participants: [OPERATOR],
    adoptId: conv.MAIN_CONVERSATION_ID,
    dir,
  })
  const side = await consoleHandoff.openSideConversation({
    question: 'what broke the tail checks?',
    askedBy: OPERATOR,
    dir,
  })
  t.check('the ask mints a NEW id (never the main id)', side.conversationId !== main.conversationId)
  t.check('the side conversation is console-side kind', side.kind === 'console-side')
  t.check(
    'parent lineage lands on the side thread',
    side.lineage.some(l => l.kind === 'parent' && l.otherConversationId === main.conversationId),
  )
  const afterAsk = await conv.conversationOf(side.conversationId, { dir })
  t.check('the asked question is the first event', afterAsk!.events[0]?.kind === 'message')
  await consoleHandoff.recordSideOutcome(
    side.conversationId,
    { kind: 'answered', response: 'the vitest pin moved' },
    { dir },
  )
  const answered = await conv.conversationOf(side.conversationId, { dir })
  t.check(
    'an answer settles ITS conversation (message + completion)',
    answered!.events.some(e => e.kind === 'completion'),
  )
  t.check(
    'the settled side thread reads completed in the inbox fold',
    inbox.deriveInboxRow(answered!, answered!.lastEventSeq).bucket === 'completed',
  )
  const failedSide = await consoleHandoff.openSideConversation({
    question: 'a doomed ask',
    askedBy: OPERATOR,
    dir,
  })
  await consoleHandoff.recordSideOutcome(failedSide.conversationId, { kind: 'failed', reason: 'stream died' }, { dir })
  const failed = await conv.conversationOf(failedSide.conversationId, { dir })
  t.check(
    'a failed side helper reads STALLED (unresolved failure event) — and only ITS thread moves',
    inbox.deriveInboxRow(failed!, 0).bucket === 'stalled' &&
      (await conv.conversationOf(main.conversationId, { dir }))!.events.length === 0,
  )
}

t.section('§2 — the handoff law: lineage, never merge')
{
  const all = await conv.listConversations({ dir })
  const side = all.find(c => c.kind === 'console-side' && c.events.some(e => e.kind === 'completion'))!
  const sideEventsBefore = side.events.length
  const receipt = await consoleHandoff.handOffSideConversation(
    side.conversationId,
    conv.MAIN_CONVERSATION_ID,
    { deliveryRef: 'receipt:hn-1', dir },
  )
  t.check('the handoff records ok', receipt.ok === true)
  const after = await conv.conversationOf(side.conversationId, { dir })
  const target = await conv.conversationOf(conv.MAIN_CONVERSATION_ID, { dir })
  t.check('the source keeps its id', after!.conversationId === side.conversationId)
  t.check(
    'both sides carry the handoff edge with the delivery ref',
    after!.lineage.some(l => l.kind === 'handoff' && l.direction === 'from' && l.ref === 'receipt:hn-1') &&
      target!.lineage.some(l => l.kind === 'handoff' && l.direction === 'to'),
  )
  t.check(
    'NO transcript moved — the target gained no message events',
    target!.events.every(e => e.kind !== 'message'),
  )
  t.check(
    'the source transcript is intact (plus its own handoff activity event)',
    after!.events.length >= sideEventsBefore,
  )
  const self = await consoleHandoff.handOffSideConversation(side.conversationId, side.conversationId, { dir })
  t.check('a self-handoff refuses', self.ok === false)
  const ghost = await consoleHandoff.handOffSideConversation(
    'cv-ghost000000' as never,
    conv.MAIN_CONVERSATION_ID,
    { dir },
  )
  t.check('an unknown conversation refuses (never a silent edge)', ghost.ok === false)
}

t.section('§3 — Minerva staging: refinement alone dispatches NOTHING')
{
  const staged = await minerva.stageRefinedDraft({
    originalText: 'fix tests',
    refinedText: 'Run the vitest pool for src/services/crew and fix the two failing seat-bridge cases',
    provenance: { source: 'minerva-chat', noteRef: 'note-42', refinedBy: 'minerva' },
    dir,
  })
  t.check('staging returns the staged state', staged.state === 'staged')
  const readBack = await minerva.stagedDraftOf(staged.stagedId, { dir })
  t.check(
    'BOTH texts survive side by side with provenance',
    readBack !== null &&
      readBack.originalText === 'fix tests' &&
      /vitest pool/.test(readBack.refinedText) &&
      readBack.provenance.noteRef === 'note-42',
  )
  const refConv = await conv.conversationOf(staged.conversationId, { dir })
  t.check(
    'the refinement minted its OWN minerva-refinement conversation with parent lineage',
    refConv !== null &&
      refConv.kind === 'minerva-refinement' &&
      refConv.lineage.some(l => l.kind === 'parent'),
  )
  t.check('no delivery event exists before the operator dispatches', refConv!.events.every(e => e.kind !== 'delivery'))
  const marked = await minerva.markStagedDispatched(staged.stagedId, 'msg-777', { dir })
  const afterMark = await minerva.stagedDraftOf(staged.stagedId, { dir })
  const convAfter = await conv.conversationOf(staged.conversationId, { dir })
  t.check(
    'the operator dispatch records the EXACT receipt ref + the delivery event',
    marked === true &&
      afterMark!.state === 'dispatched' &&
      afterMark!.deliveryReceiptRef === 'msg-777' &&
      convAfter!.events.some(e => e.kind === 'delivery' && e.ref === 'receipt:msg-777'),
  )
  const again = await minerva.markStagedDispatched(staged.stagedId, 'msg-778', { dir })
  t.check('a settled draft cannot re-dispatch through the stage', again === false)
  const staged2 = await minerva.stageRefinedDraft({
    originalText: 'b',
    refinedText: 'refined b',
    provenance: { source: 'minerva-chat', refinedBy: 'minerva' },
    dir,
  })
  const dismissed = await minerva.dismissStagedDraft(staged2.stagedId, { dir })
  t.check('dismissal settles ONLY the draft', dismissed === true && (await minerva.stagedDraftOf(staged2.stagedId, { dir }))!.state === 'dismissed')
}

t.section('§4 — per-conversation draft identity on the ONE document owner')
{
  const a = composer.conversationScope('cv-aaa')
  const b = composer.conversationScope('cv-bbb')
  const aReply = composer.conversationScope('cv-aaa', 'reply')
  t.check('two conversations key two DIFFERENT scopes', a !== b)
  t.check('the composer family stays distinct within one conversation', a !== aReply)
  const docA = composer.createComposerDocument(a)
  const docB = composer.createComposerDocument(b)
  const withChip = composer.addShelfItem(docA, { kind: 'resource', ref: 'mercury://artifact/x', label: 'x' })
  t.check(
    'adding to one conversation shelf never touches the other (value semantics + distinct scopes)',
    withChip.items.length === 1 && docB.items.length === 0 && withChip.scope !== docB.scope,
  )
  t.check(
    "the shelf vocabulary carries 'resource' (stored once, carried by ref)",
    (composer.SHELF_ITEM_KINDS as readonly string[]).includes('resource'),
  )
}

t.section('§5 — the ONE teammate target picker')
{
  const snapshot = {
    v: 1 as const,
    version: 1,
    refreshedAt: Date.now(),
    members: [
      {
        agentId: 'cw-mainmainmain' as never,
        displayName: 'Mercury',
        label: 'Mercury',
        visualToken: 'crew-0',
        presence: { state: 'online' as const, source: 'session', observedAt: Date.now() },
        roles: [],
        sessions: [],
        refs: [],
      },
      {
        agentId: 'cw-adapteragent' as never,
        displayName: 'Atlas',
        label: 'Atlas',
        visualToken: 'crew-1',
        presence: { state: 'unknown' as const, source: 'adapter:claude-code:unobserved', observedAt: Date.now() },
        roles: [],
        sessions: [],
        refs: [],
      },
    ],
    sources: {
      identity: { state: 'ready' as const },
      party: { state: 'ready' as const },
      workbench: { state: 'ready' as const },
    },
  }
  const rows = picker.targetPickerRows(snapshot as never)
  t.check('every directory member gets a row (the full picker view)', rows.length === 2)
  const main = rows.find(r => (r.agentId as string) === 'cw-mainmainmain')
  const external = rows.find(r => (r.agentId as string) === 'cw-adapteragent')
  t.check(
    'the main agent is dispatchable via its local queue',
    main?.dispatchable === true && main.endpoint === 'local-queue',
  )
  t.check(
    'an unattached external agent is NOT dispatchable (no guaranteed-refusal advertising)',
    external?.dispatchable === false && external.endpoint === 'none',
  )
  const targets = picker.dispatchableTargets(snapshot as never)
  t.check('dispatchableTargets is exactly the sendable subset', targets.length === 1 && targets[0]!.agentId === main!.agentId)
  t.check('a null snapshot yields an empty picker (honest absence)', picker.targetPickerRows(null).length === 0)
}

t.finish('prove-continuity-handoffs')
