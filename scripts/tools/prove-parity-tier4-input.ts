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

const { retainFullscreenScrollback } = await import('../../src/utils/messages/fullscreenScrollback.ts')
const m = (id: string) => ({ uuid: id })
const prev = [m('a1'), m('b1-boundary'), m('a2'), m('b2-boundary'), m('tail1'), m('tail2')]
const keptAll = retainFullscreenScrollback(prev, undefined)
t('with no re-yielded tail, the FULL history is kept', keptAll.length === prev.length)
const keptTrimmed = retainFullscreenScrollback(prev, 'tail1')
t(
  'the re-yielded verbatim tail is dropped, everything before it kept',
  keptTrimmed.map(x => x.uuid).join(',') === 'a1,b1-boundary,a2,b2-boundary',
)
t(
  'earlier intervals are NOT dropped (both prior boundaries survive)',
  keptTrimmed.some(x => x.uuid === 'b1-boundary') && keptTrimmed.some(x => x.uuid === 'b2-boundary'),
)

process.exit(failures)
