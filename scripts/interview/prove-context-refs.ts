#!/usr/bin/env bun

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
} = await import('../../src/tools/engines/interview/controller.ts')
const { interviewSnapshot, interviewEvents, _resetInterviewForProofs } = await import(
  '../../src/tools/engines/interview/store.ts'
)
const { buildDecisionRecord } = await import('../../src/tools/engines/interview/decisionRecord.ts')
const { commitAnswer } = await import('../../src/tools/engines/interview/controller.ts')
const { addShelfItem, createComposerDocument, reorderShelfItem } = await import(
  '../../src/screen/composer/input-core/composer-document.ts'
)
const { hashPastedText, storePastedText } = await import('../../src/sessions/pasteStore.ts')
const { cacheImagePath, storeImage } = await import('../../src/platform/images/imageStore.ts')

const baseChecker = checker()
const t = {
  ...baseChecker,
  check: (label: string, cond: boolean, detail = '', hint = ''): void =>
    baseChecker.check(label, cond, cond ? detail : [detail, hint].filter(Boolean).join(' — ')),
}

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
    'attachContext in src/tools/engines/interview/controller.ts must append the context-attached event, and its case in applyEvent in src/tools/engines/interview/contracts.ts must add the ref in order',
  )
  t.check('the image is scoped to decision 1', s.contextScope['image:1'] === q1.id, '', 'the context-attached case in applyEvent (src/tools/engines/interview/contracts.ts) must record the questionId in contextScope')
  t.check('the paste is scoped to decision 2', s.contextScope['paste:abc'] === q2.id, '', 'the context-attached case in applyEvent (src/tools/engines/interview/contracts.ts) must record the questionId in contextScope')
  t.check('the file is interview-wide (absent scope)', s.contextScope['file:src/x.ts'] === undefined, '', 'an attach with no questionId must leave contextScope empty for that ref: context-attached case in applyEvent, src/tools/engines/interview/contracts.ts')
  const before = s
  attachContext({ refId: 'image:1', kind: 'image', label: 'diagram.png' }, q1.id)
  t.check(
    'a duplicate refId attach is a semantic no-op (slice identity)',
    interviewSnapshot().context === before.context && interviewSnapshot().contextScope === before.contextScope,
    '',
    'a repeated refId must return the same state slices: context-attached case in applyEvent, src/tools/engines/interview/contracts.ts',
  )
}

t.section('§2 — detach removes exactly one; identity and order survive')
{
  detachContext('paste:abc')
  const s = interviewSnapshot()
  t.check('the detached ref is gone', !s.context.some(c => c.refId === 'paste:abc'), '', 'detachContext in src/tools/engines/interview/controller.ts and the context-detached case in applyEvent in src/tools/engines/interview/contracts.ts must remove the ref')
  t.check(
    'the OTHERS keep identity and order',
    s.context.map(c => c.refId).join(',') === 'image:1,file:src/x.ts',
    s.context.map(c => c.refId).join(','),
    'the context-detached case in applyEvent (src/tools/engines/interview/contracts.ts) must remove only the named ref and keep the order of the others',
  )
  t.check('its scope entry is cleaned', !('paste:abc' in s.contextScope), '', 'the context-detached case in applyEvent (src/tools/engines/interview/contracts.ts) must delete the ref from contextScope')
  const before = s
  detachContext('paste:abc')
  t.check(
    'detaching an absent ref is a semantic no-op (slice identity)',
    interviewSnapshot().context === before.context && interviewSnapshot().contextScope === before.contextScope,
    '',
    'a detach of an unknown refId must return the same state slices: context-detached case in applyEvent, src/tools/engines/interview/contracts.ts',
  )
}

t.section('§3 — undo is re-attach: the SAME refId, the same scope')
{
  attachContext({ refId: 'paste:abc', kind: 'large-paste', label: 'Pasted text · 40 lines' }, q2.id)
  const s = interviewSnapshot()
  t.check('the ref is back under its own identity', s.context.some(c => c.refId === 'paste:abc'), '', 'attachContext (src/tools/engines/interview/controller.ts) must accept the same refId again after a detach')
  t.check('with its per-decision scope restored', s.contextScope['paste:abc'] === q2.id, '', 'the context-attached case in applyEvent (src/tools/engines/interview/contracts.ts) must store the questionId again')
}

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
    'buildDecisionRecord in src/tools/engines/interview/decisionRecord.ts must list the refs scoped to the decision plus the interview-wide refs',
  )
  t.check(
    'decision 2 carries ITS scoped ref + the interview-wide ref',
    d2.contextRefIds.join(',') === 'file:src/x.ts,paste:abc',
    d2.contextRefIds.join(','),
    'buildDecisionRecord in src/tools/engines/interview/decisionRecord.ts must list the refs scoped to the decision plus the interview-wide refs',
  )
  t.check('no decision carries another decision\'s scoped ref', !d1.contextRefIds.includes('paste:abc') && !d2.contextRefIds.includes('image:1'), '', 'the contextRefIds filter in buildDecisionRecord (src/tools/engines/interview/decisionRecord.ts) must drop refs scoped to a different decision')
}

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
    '',
    'reorderShelfItem in src/screen/composer/input-core/composer-document.ts must only permute the existing items, moving the item one place by the given offset',
  )
  t.check('the moved item kept its identity and ref', reordered.items[1]!.id === ids[2] && reordered.items[1]!.ref === 'mercury://session/x', '', 'reorderShelfItem in src/screen/composer/input-core/composer-document.ts must move the item without rebuilding its id or ref')
  t.check(
    'the interview joins by refId, order-independent (identity, not position)',
    imageRefNumericId('image:1') === 1 && imageRefNumericId('paste:abc') === null,
    '',
    'imageRefNumericId in src/tools/engines/interview/controller.ts must return the number for an image: refId and null for any other refId',
  )
}

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
  t.check('the image body arrived from the imageStore', imageBlock !== undefined && (imageBlock as { source: { data: string } }).source.data.length > 0, '', 'buildContextBlocks in src/tools/engines/interview/controller.ts must read the image body from the image store (src/platform/images/imageStore.ts) for an image: ref')
  t.check('the text body arrived from the pasteStore', textBlock !== undefined && (textBlock as { text: string }).text.includes('pasted line 60'), '', 'buildContextBlocks in src/tools/engines/interview/controller.ts must read the pasted text from the paste store (src/sessions/pasteStore.ts) for a paste: ref')
  t.check(
    'tagged with its refId AND its decision',
    (textBlock as { text: string } | undefined)?.text.includes(`ref="paste:${hash}"`) === true &&
      (textBlock as { text: string } | undefined)?.text.includes(`decision="${q2.decisionId}"`) === true,
    '',
    'buildContextBlocks in src/tools/engines/interview/controller.ts must tag each text block with its ref and decision attributes',
  )

  attachContext({ refId: 'image:999', kind: 'image', label: 'lost.png' }, q1.id)
  const withMissing = (await buildContextBlocks(interviewSnapshot())) ?? []
  t.check('a missing body is a bounded skip', withMissing.length === blocks.length, '', 'buildContextBlocks in src/tools/engines/interview/controller.ts must skip a ref whose body is not in the store instead of adding a block or throwing')
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-context-refs')
