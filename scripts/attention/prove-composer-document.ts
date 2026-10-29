#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/input-core/composer-document.ts') | null = null
try {
  m = await import('../../src/input-core/composer-document.ts')
} catch {
  m = null
}
if (!m) {
  t.check('src/input-core/composer-document.ts loads', false, 'module absent')
  t.section('§5 — restart restore: the scoped-docs store round-trip')
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rv-scoped-'))
  const { saveScopedDoc, readScopedDocsSync, flushScopedDocSaves } = await import('../../src/utils/promptDraft.ts')
  let doc = C.createComposerDocument('dispatch')
  doc = { ...doc, body: 'run the tail checks' }
  doc = C.addShelfItem(doc, { kind: 'artifact', ref: 'mercury://artifact/ra-7', label: 'plan' })
  await saveScopedDoc('sess-1', doc)
  await flushScopedDocSaves()
  const back = readScopedDocsSync('sess-1')
  t.check(
    'restart restores body + shelf together (sync read, refs intact)',
    back !== null &&
      back['dispatch']?.body === 'run the tail checks' &&
      back['dispatch']?.items[0]?.ref === 'mercury://artifact/ra-7',
  )
  await saveScopedDoc('sess-1', C.createComposerDocument('dispatch'))
  await flushScopedDocSaves()
  const gone = readScopedDocsSync('sess-1')
  t.check(
    'an EMPTY document deletes its scope (a submitted composer never resurrects)',
    gone === null || gone['dispatch'] === undefined,
  )
}

t.finish('prove-composer-document')
}
const C = m!
const { hashPastedText } = await import('../../src/utils/pasteStore.ts')

t.section('§1 — single body by id')
{
  const body = 'const x = 1\n'.repeat(200)
  const doc = C.createComposerDocument('dispatch')
  const withPaste = C.addLargePaste(doc, body)
  const item = withPaste.items[0]!
  t.check('the chip references the pasteStore hash', item.ref === hashPastedText(body))
  t.check(
    'the chip label is honest (lines + bytes)',
    item.kind === 'large-paste' && /200 lines/.test(item.label),
    item.label,
  )
  t.check(
    'the DOCUMENT holds no body copy (structural: the paste text appears nowhere in it)',
    !JSON.stringify(withPaste).includes('const x = 1\nconst x = 1'),
  )
}

t.section('§2 — deterministic migration, first-reference order')
{
  const pasted = {
    2: { id: 2, type: 'text' as const, content: 'SECOND-BODY '.repeat(100) },
    1: { id: 1, type: 'text' as const, content: 'FIRST-BODY '.repeat(100) },
    3: { id: 3, type: 'image' as const, content: 'aGVsbG8=', mediaType: 'image/png' },
  }
  const draft = 'look at [Pasted text #2 +99 lines] then [Image #3] then [Pasted text #1 +99 lines]'
  const a = C.migrateDraft('main', draft, pasted as never)
  const b = C.migrateDraft('main', draft, pasted as never)
  t.check(
    'FIRST-REFERENCE order is preserved (#2 · image #3 · #1)',
    a.items.map(i => i.kind).join(',') === 'large-paste,image,large-paste' &&
      a.items[0]!.ref === hashPastedText(pasted[2].content) &&
      a.items[2]!.ref === hashPastedText(pasted[1].content),
    a.items.map(i => `${i.kind}:${i.ref.slice(0, 6)}`).join(' · '),
  )
  t.check('the body keeps the placeholder text verbatim (the refs ARE the truth)', a.body === draft)
  t.check(
    'migration is deterministic (twice ≡ once, ids aside)',
    JSON.stringify(a.items.map(i => [i.kind, i.ref, i.label])) ===
      JSON.stringify(b.items.map(i => [i.kind, i.ref, i.label])),
  )
}

t.section('§3 — the ONE normalization rule')
{
  const raw = 'a\u001b[31mred\u001b[0m\r\nb\rc\td'
  t.check(
    'strip-ansi + CRLF/CR→LF + tab→4 spaces, exactly the shipped rule',
    C.normalizePastedInput(raw) === 'ared\nb\nc    d',
    JSON.stringify(C.normalizePastedInput(raw)),
  )
  t.check(
    'the line rule alone keeps the tabs: a pasted chip carries the bytes the model reads',
    C.normalizePastedLines(raw) === 'ared\nb\nc\td',
    JSON.stringify(C.normalizePastedLines(raw)),
  )
  const prompt = readFileSync('src/components/PromptInput/useComposerAttachments.ts', 'utf8')
  t.check(
    'PromptInput consumes the extracted rules (the line rule for the chip, expandTabs for the composer text) — no drift possible',
    prompt.includes('normalizePastedLines') && prompt.includes('expandTabs(exact)'),
  )
  t.check(
    'the inline spelling is GONE from PromptInput',
    !prompt.includes(".replace(/\\r\\n?/g, '\\n').replaceAll('\\t', '    ')"),
  )
}

t.section('§4 — honest states, undo material, pure reorder')
{
  let doc = C.createComposerDocument('reply')
  doc = C.addLargePaste(doc, 'aaa\nbbb\n')
  doc = C.addShelfItem(doc, { kind: 'file', ref: '/tmp/x.ts', label: 'x.ts' })
  doc = C.addShelfItem(doc, { kind: 'artifact', ref: 'mercury://artifact/ra-1', label: 'plan' })
  const ids = doc.items.map(i => i.id)
  const re = C.reorderShelfItem(doc, ids[2]!, -1)
  t.check(
    'reorder is a pure permutation (same ids, new order)',
    re.items.map(i => i.id).join(',') === [ids[0], ids[2], ids[1]].join(','),
  )
  const { doc: removed, removed: gone } = C.removeShelfItem(re, ids[0]!)
  t.check(
    'remove returns the removed item (the undo material)',
    gone !== null && gone.id === ids[0] && removed.items.length === 2,
  )
  const big = C.addLargePaste(C.createComposerDocument('main'), 'x'.repeat(2_000_000))
  t.check(
    "an oversize paste reads 'too-large' explicitly — never a silent truncation",
    big.items[0]!.state === 'too-large' && big.items[0]!.bytes === 2_000_000,
    `${big.items[0]!.state} bytes=${big.items[0]!.bytes}`,
  )
  for (const [label, content, bytes] of [['a CJK ideograph', '漢', 3], ['an Arabic word', 'تفلسف', 10], ['a Hebrew word with niqqud', 'שָׁלוֹם', 14], ['a Persian word with the joiner', 'می\u200cخواهم', 17], ['a combining Latin letter', 'e\u0301', 3], ['an astral emoji', '🦀', 4]] as const) {
    const pasted = C.addLargePaste(C.createComposerDocument('main'), content)
    t.check(
      `the chip counts UTF-8 bytes, not UTF-16 units: ${label} is ${bytes} B`,
      pasted.items[0]!.bytes === bytes && pasted.items[0]!.label.endsWith(`· ${bytes} B`),
      `bytes=${pasted.items[0]!.bytes} label=${pasted.items[0]!.label}`,
    )
  }
  const migrated = C.migrateDraft('main', 'see [Pasted text #4 +1 lines]', { 4: { id: 4, type: 'text', content: 'بلا تفلسف\n' } } as never)
  t.check(
    'a migrated paste counts the same UTF-8 bytes',
    migrated.items[0]!.bytes === 18 && migrated.items[0]!.label.endsWith('· 18 B'),
    `bytes=${migrated.items[0]!.bytes} label=${migrated.items[0]!.label}`,
  )
  const nearlyOver = C.addLargePaste(C.createComposerDocument('main'), '漢'.repeat(Math.floor(C.SHELF_ITEM_TOO_LARGE_BYTES / 3) + 1))
  t.check(
    'the too-large line is drawn on bytes: a third of a mebibyte of ideographs plus one crosses it',
    nearlyOver.items[0]!.state === 'too-large',
    `${nearlyOver.items[0]!.state} bytes=${nearlyOver.items[0]!.bytes}`,
  )
}

t.section('§5 — restart restore: the scoped-docs store round-trip')
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rv-scoped-'))
  const { saveScopedDoc, readScopedDocsSync, flushScopedDocSaves } = await import('../../src/utils/promptDraft.ts')
  let doc = C.createComposerDocument('dispatch')
  doc = { ...doc, body: 'run the tail checks' }
  doc = C.addShelfItem(doc, { kind: 'artifact', ref: 'mercury://artifact/ra-7', label: 'plan' })
  await saveScopedDoc('sess-1', doc)
  await flushScopedDocSaves()
  const back = readScopedDocsSync('sess-1')
  t.check(
    'restart restores body + shelf together (sync read, refs intact)',
    back !== null &&
      back['dispatch']?.body === 'run the tail checks' &&
      back['dispatch']?.items[0]?.ref === 'mercury://artifact/ra-7',
  )
  await saveScopedDoc('sess-1', C.createComposerDocument('dispatch'))
  await flushScopedDocSaves()
  const gone = readScopedDocsSync('sess-1')
  t.check(
    'an EMPTY document deletes its scope (a submitted composer never resurrects)',
    gone === null || gone['dispatch'] === undefined,
  )
}

t.finish('prove-composer-document')
