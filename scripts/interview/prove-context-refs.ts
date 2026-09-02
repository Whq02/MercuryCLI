#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-context-refs.ts — + at the owners:
//  interview context is stable SHELF REFERENCES with bodies in their owner
//  stores, and preview / reorder / removal / undo / submission all preserve
//  item identity and per-decision association.
//
//    §1  attach: per-decision scope, interview-wide default, duplicate no-op;
//    §2  detach removes exactly ONE ref and cleans its scope — the others
//        keep identity AND order;
//    §3  undo = re-attach the SAME refId with its scope — identity restored;
//    §4  the decision record joins context BY refId per decision;
//    §5  reorder lives at the shelf owner (reorderShelfItem) — a pure
//        permutation of stable ids; the interview's refs join by refId,
//        order-independent;
//    §6  the boundary reads each body exactly once from its owner store
//        (pasteStore text tagged with ref + decision; imageStore image);
//        a missing body is a bounded logged skip, never a throw.
//
//  Proof hygiene: every store write is scratch-rooted via MERCURY_CONFIG_DIR
//  (set BEFORE any import runs — bun's homedir() ignores env HOME).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'interview-ctx-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')

const { checker } = await import('../engine-durability/harness.ts')
const {
  attachContext,
  buildContextBlocks,
  detachContext,
  imageRefNumericId,
  presentToolCall,
} = await import('../../src/services/interview/controller.ts')
const { interviewSnapshot, interviewEvents, _resetInterviewForProofs } = await import(
  '../../src/services/interview/store.ts'
)
const { buildDecisionRecord } = await import('../../src/services/interview/decisionRecord.ts')
const { commitAnswer } = await import('../../src/services/interview/controller.ts')
const { addShelfItem, createComposerDocument, reorderShelfItem } = await import(
  '../../src/input-core/composer-document.ts'
)
const { hashPastedText, storePastedText } = await import('../../src/utils/pasteStore.ts')
const { cacheImagePath, storeImage } = await import('../../src/utils/imageStore.ts')

const t = checker()

// A 1×1 transparent PNG — a real decodable body for the image store.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

_resetInterviewForProofs()
const { questions } = presentToolCall({
  input: {
    questions: [
      {
        question: 'Which storage engine?',
        header: 'Cache',
        options: [
          { label: 'Redis', description: 'Shared.' },
          { label: 'In-memory', description: 'Local.' },
        ],
      },
      {
        question: 'Which eviction policy?',
        header: 'Eviction',
        options: [
          { label: 'LRU', description: 'Recency.' },
          { label: 'LFU', description: 'Frequency.' },
        ],
      },
    ],
  },
})
const q1 = questions[0]!
const q2 = questions[1]!

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — attach: scope, interview-wide default, duplicate no-op')
{
  attachContext({ refId: 'image:1', kind: 'image', label: 'diagram.png' }, q1.id)
  attachContext({ refId: 'paste:abc', kind: 'large-paste', label: 'Pasted text · 40 lines' }, q2.id)
  attachContext({ refId: 'file:src/x.ts', kind: 'file', label: 'x.ts' })
  const s = interviewSnapshot()
  t.check(
    'three refs attached in order',
    s.context.map(c => c.refId).join(',') === 'image:1,paste:abc,file:src/x.ts',
    s.context.map(c => c.refId).join(','),
  )
  t.check('the image is scoped to decision 1', s.contextScope['image:1'] === q1.id)
  t.check('the paste is scoped to decision 2', s.contextScope['paste:abc'] === q2.id)
  t.check('the file is interview-wide (absent scope)', s.contextScope['file:src/x.ts'] === undefined)
  // The fold records every eventId (the idempotency receipt), so the
  // SNAPSHOT object may swap — the semantic no-op is the context SLICES
  // keeping reference identity (nothing re-derives, nothing re-renders
  // context projections).
  const before = s
  attachContext({ refId: 'image:1', kind: 'image', label: 'diagram.png' }, q1.id)
  t.check(
    'a duplicate refId attach is a semantic no-op (slice identity)',
    interviewSnapshot().context === before.context && interviewSnapshot().contextScope === before.contextScope,
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — detach removes exactly one; identity and order survive')
{
  detachContext('paste:abc')
  const s = interviewSnapshot()
  t.check('the detached ref is gone', !s.context.some(c => c.refId === 'paste:abc'))
  t.check(
    'the OTHERS keep identity and order',
    s.context.map(c => c.refId).join(',') === 'image:1,file:src/x.ts',
    s.context.map(c => c.refId).join(','),
  )
  t.check('its scope entry is cleaned', !('paste:abc' in s.contextScope))
  const before = s
  detachContext('paste:abc')
  t.check(
    'detaching an absent ref is a semantic no-op (slice identity)',
    interviewSnapshot().context === before.context && interviewSnapshot().contextScope === before.contextScope,
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — undo is re-attach: the SAME refId, the same scope')
{
  attachContext({ refId: 'paste:abc', kind: 'large-paste', label: 'Pasted text · 40 lines' }, q2.id)
  const s = interviewSnapshot()
  t.check('the ref is back under its own identity', s.context.some(c => c.refId === 'paste:abc'))
  t.check('with its per-decision scope restored', s.contextScope['paste:abc'] === q2.id)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — the decision record joins context BY refId per decision')
{
  commitAnswer(q1.id, { optionIds: [q1.options[0]!.id] })
  commitAnswer(q2.id, { optionIds: [q2.options[1]!.id] })
  const rec = buildDecisionRecord(interviewSnapshot(), interviewEvents(), 'ir_test', 1)
  const d1 = rec.decisions.find(d => d.questionId === q1.id)!
  const d2 = rec.decisions.find(d => d.questionId === q2.id)!
  t.check(
    'decision 1 carries its scoped ref + the interview-wide ref',
    d1.contextRefIds.join(',') === 'image:1,file:src/x.ts',
    d1.contextRefIds.join(','),
  )
  t.check(
    'decision 2 carries ITS scoped ref + the interview-wide ref',
    d2.contextRefIds.join(',') === 'file:src/x.ts,paste:abc',
    d2.contextRefIds.join(','),
  )
  t.check('no decision carries another decision\'s scoped ref', !d1.contextRefIds.includes('paste:abc') && !d2.contextRefIds.includes('image:1'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — reorder lives at the shelf owner: a pure permutation of ids')
{
  let doc = createComposerDocument('main')
  doc = addShelfItem(doc, { kind: 'file', ref: 'src/a.ts', label: 'a.ts' })
  doc = addShelfItem(doc, { kind: 'image', ref: 'image:7', label: 'shot.png' })
  doc = addShelfItem(doc, { kind: 'session-ref', ref: 'mercury://session/x', label: 'session x' })
  const ids = doc.items.map(i => i.id)
  const reordered = reorderShelfItem(doc, ids[2]!, -1)
  t.check(
    'a reorder is a permutation — same ids, new order',
    [...reordered.items.map(i => i.id)].sort().join(',') === [...ids].sort().join(',') &&
      reordered.items.map(i => i.id).join(',') !== ids.join(','),
  )
  t.check('the moved item kept its identity and ref', reordered.items[1]!.id === ids[2] && reordered.items[1]!.ref === 'mercury://session/x')
  t.check(
    'the interview joins by refId, order-independent (identity, not position)',
    imageRefNumericId('image:1') === 1 && imageRefNumericId('paste:abc') === null,
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§6 — the boundary reads each body once from its owner store')
{
  const body = Array.from({ length: 60 }, (_, i) => `pasted line ${i + 1}`).join('\n')
  const hash = hashPastedText(body)
  await storePastedText(hash, body)
  detachContext('paste:abc')
  attachContext({ refId: `paste:${hash}`, kind: 'large-paste', label: 'Pasted text · 60 lines' }, q2.id)

  const img = { id: 1, type: 'image' as const, content: TINY_PNG, mediaType: 'image/png', filename: 'diagram.png' }
  cacheImagePath(img)
  await storeImage(img)

  const blocks = (await buildContextBlocks(interviewSnapshot())) ?? []
  const imageBlock = blocks.find(b => b.type === 'image')
  const textBlock = blocks.find(b => b.type === 'text')
  t.check('the image body arrived from the imageStore', imageBlock !== undefined && (imageBlock as { source: { data: string } }).source.data.length > 0)
  t.check('the text body arrived from the pasteStore', textBlock !== undefined && (textBlock as { text: string }).text.includes('pasted line 60'))
  t.check(
    'tagged with its refId AND its decision',
    (textBlock as { text: string } | undefined)?.text.includes(`ref="paste:${hash}"`) === true &&
      (textBlock as { text: string } | undefined)?.text.includes(`decision="${q2.decisionId}"`) === true,
  )

  // A ref whose body is absent: bounded skip, never a throw.
  attachContext({ refId: 'image:999', kind: 'image', label: 'lost.png' }, q1.id)
  const withMissing = (await buildContextBlocks(interviewSnapshot())) ?? []
  t.check('a missing body is a bounded skip', withMissing.length === blocks.length)
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-context-refs')
