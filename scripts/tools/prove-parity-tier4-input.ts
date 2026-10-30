#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const queue = (await import('../../src/input-core/command-queue.ts')) as Record<string, unknown>
t('popNewestEditable stays retired', typeof queue.popNewestEditable === 'undefined')
t('popAllEditable stays retired', typeof queue.popAllEditable === 'undefined')

const { resolveToolJSX } = await import('../../src/screens/toolJsxArbitration.ts')
const dialog = { jsx: 'DIALOG', shouldHidePromptInput: false, isLocalJSXCommand: true } as never
const progress = { jsx: 'PROGRESS', shouldHidePromptInput: false, deferIfLocalJSX: true } as never
const teardown = { jsx: null, shouldHidePromptInput: false, clearUnlessLocalJSX: true } as never

t(
  "a bang's progress render yields to a dialog already in the slot",
  resolveToolJSX(dialog, progress) === dialog,
)
t(
  "a bang's teardown preserves a dialog that opened over it",
  resolveToolJSX(dialog, teardown) === dialog,
)
t(
  "a bang's teardown clears its OWN progress when no dialog took the slot",
  resolveToolJSX(progress, teardown) === null,
)
t(
  'a bang progress render still paints when the slot is its own',
  resolveToolJSX(progress, { jsx: 'P2', shouldHidePromptInput: false, deferIfLocalJSX: true } as never) !== progress,
)
t('a null write always clears', resolveToolJSX(dialog, null) === null)

const { escapeXml, unescapeXml } = await import('../../src/utils/xml.ts')
const raw = 'error: a && b < c > d, "q" & \'e\''
t('unescapeXml inverts escapeXml exactly', unescapeXml(escapeXml(raw)) === raw)
t(
  'entities do not survive to display',
  !unescapeXml(escapeXml('x < y & z')).includes('&amp;') && !unescapeXml(escapeXml('x < y & z')).includes('&lt;'),
)

const { emptyFoldState, applyTranscriptEntry } = await import('../../src/utils/sessionStorage/fold.ts')
const { buildScreenConversation } = await import('../../src/utils/sessionStorage/chain.ts')
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
t('the live screen chain retains the full linked history', original.map(row => row.uuid).join(',') === ids.join(','))
for (const row of rows.slice(-2)) applyTranscriptEntry(state, { ...row } as never)
const replayed = buildScreenConversation(state.messages)
t('replaying the same tail creates no duplicate screen rows', replayed.length === ids.length && new Set(replayed.map(row => row.uuid)).size === ids.length)
t('both prior boundaries survive the tail replay', ['b1-boundary', 'b2-boundary'].every(id => replayed.some(row => String(row.uuid) === id)))

process.exit(failures)
