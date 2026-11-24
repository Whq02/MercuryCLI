#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = '', failHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && failHint ? ` — ${failHint}` : ''}`)
  if (!ok) failures = 1
}

const queue = (await import('../../src/screen/composer/input-core/command-queue.ts')) as Record<string, unknown>
t('popNewestEditable stays retired', typeof queue.popNewestEditable === 'undefined', '', 'remove the popNewestEditable export from src/screen/composer/input-core/command-queue.ts')
t('popAllEditable stays retired', typeof queue.popAllEditable === 'undefined', '', 'remove the popAllEditable export from src/screen/composer/input-core/command-queue.ts')

const { resolveToolJSX } = await import('../../src/screen/chat/toolJsxArbitration.ts')
const dialog = { jsx: 'DIALOG', shouldHideComposer: false, isLocalJSXCommand: true } as never
const progress = { jsx: 'PROGRESS', shouldHideComposer: false, deferIfLocalJSX: true } as never
const teardown = { jsx: null, shouldHideComposer: false, clearUnlessLocalJSX: true } as never

t(
  "a bang's progress render yields to a dialog already in the slot",
  resolveToolJSX(dialog, progress) === dialog,
  '',
  'resolveToolJSX in src/screen/chat/toolJsxArbitration.ts must return the previous dialog when the next state is a deferIfLocalJSX progress render',
)
t(
  "a bang's teardown preserves a dialog that opened over it",
  resolveToolJSX(dialog, teardown) === dialog,
  '',
  'resolveToolJSX in src/screen/chat/toolJsxArbitration.ts must keep the previous dialog when the next state is a clearUnlessLocalJSX teardown',
)
t(
  "a bang's teardown clears its OWN progress when no dialog took the slot",
  resolveToolJSX(progress, teardown) === null,
  '',
  'resolveToolJSX in src/screen/chat/toolJsxArbitration.ts must return null for a clearUnlessLocalJSX teardown over a non-dialog state',
)
t(
  'a bang progress render still paints when the slot is its own',
  resolveToolJSX(progress, { jsx: 'P2', shouldHideComposer: false, deferIfLocalJSX: true } as never) !== progress,
  '',
  'resolveToolJSX in src/screen/chat/toolJsxArbitration.ts must return the new progress state when the previous state is not a dialog',
)
t('a null write always clears', resolveToolJSX(dialog, null) === null, '', 'resolveToolJSX in src/screen/chat/toolJsxArbitration.ts must return null whenever the next state is null')

const { escapeXml, unescapeXml } = await import('../../src/platform/text/xml.ts')
const raw = 'error: a && b < c > d, "q" & \'e\''
t('unescapeXml inverts escapeXml exactly', unescapeXml(escapeXml(raw)) === raw, '', 'make escapeXml and unescapeXml in src/platform/text/xml.ts exact inverses for the characters & < > and both quote marks')
t(
  'entities do not survive to display',
  !unescapeXml(escapeXml('x < y & z')).includes('&amp;') && !unescapeXml(escapeXml('x < y & z')).includes('&lt;'),
  '',
  'unescapeXml in src/platform/text/xml.ts must decode &amp; and &lt; back to & and <',
)

const { emptyFoldState, applyTranscriptEntry } = await import('../../src/sessions/transcripts/fold.ts')
const { buildScreenConversation } = await import('../../src/sessions/transcripts/chain.ts')
const state = emptyFoldState()
const ids = ['a1', 'b1-boundary', 'a2', 'b2-boundary', 'tail1', 'tail2']
const rows = ids.map((uuid, i) => ({
  uuid,
  parentUuid: ids[i - 1] ?? null,
  timestamp: new Date(i * 1000).toISOString(),
  ...(uuid.includes('boundary') ? { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 1 } } : { type: 'user', message: { role: 'user', content: uuid } }),
}))
for (const row of rows) applyTranscriptEntry(state, row as never)
const original = buildScreenConversation(state.messages)
t('the live screen chain retains the full linked history', original.map(row => row.uuid).join(',') === ids.join(','), '', 'buildScreenConversation in src/sessions/transcripts/chain.ts must keep every row across compact boundaries, in parent order; also check applyTranscriptEntry in src/sessions/transcripts/fold.ts')
for (const row of rows.slice(-2)) applyTranscriptEntry(state, { ...row } as never)
const replayed = buildScreenConversation(state.messages)
t('replaying the same tail creates no duplicate screen rows', replayed.length === ids.length && new Set(replayed.map(row => row.uuid)).size === ids.length, '', 'applyTranscriptEntry in src/sessions/transcripts/fold.ts must ignore an entry whose uuid is already folded, so buildScreenConversation in chain.ts returns no duplicate rows')
t('both prior boundaries survive the tail replay', ['b1-boundary', 'b2-boundary'].every(id => replayed.some(row => String(row.uuid) === id)), '', 'buildScreenConversation in src/sessions/transcripts/chain.ts must keep both compact_boundary rows after a tail replay through applyTranscriptEntry in fold.ts')

process.exit(failures)
