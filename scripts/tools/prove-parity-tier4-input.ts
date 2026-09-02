#!/usr/bin/env bun
// ============================================================================
//  prove-parity-tier4-input — frontier-sweep #1, tier 4 mechanisms:
//
//   1. Queued-command mode survives recall (item 29): a queued `!` bash
//      command pulled back into the composer returns in bash mode, not as
//      plain prompt text the model would receive; a mixed-mode pop-all
//      falls back to 'prompt'.
//   2. The toolJSX slot arbiter (item 33): a foreground `!` command's
//      progress render and teardown never destroy a permission/slash
//      dialog that opened over it — the dialog survives the command
//      finishing.
//   3. bash stderr renders real characters, never HTML entities (item 35):
//      escapeXml at write is reversed by unescapeXml at display.
//   4. Fullscreen scrollback keeps the FULL pre-compaction history across
//      repeated compactions (item 59), not just the latest interval.
// ============================================================================

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. queued-command recall RETIRED (steer-removal) ————————————————
// Item 29's subject — the pop-to-composer recall and its mode-restore
// discipline — died with the operator-facing holding pen: a sent message
// is delivered, never held, so nothing recalls. POISON: the pops must not
// return without their mode-restore law returning with them.
const queue = (await import('../../src/input-core/command-queue.ts')) as Record<string, unknown>
t('popNewestEditable stays retired', typeof queue.popNewestEditable === 'undefined')
t('popAllEditable stays retired', typeof queue.popAllEditable === 'undefined')

// —— 2. toolJSX slot arbitration ——————————————————————————————————
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

// —— 3. stderr entity round-trip ——————————————————————————————————
const { escapeXml, unescapeXml } = await import('../../src/utils/xml.ts')
const raw = 'error: a && b < c > d, "q" & \'e\''
t('unescapeXml inverts escapeXml exactly', unescapeXml(escapeXml(raw)) === raw)
t(
  'entities do not survive to display',
  !unescapeXml(escapeXml('x < y & z')).includes('&amp;') && !unescapeXml(escapeXml('x < y & z')).includes('&lt;'),
)

// —— 4. fullscreen scrollback retention ——————————————————————————————
const { retainFullscreenScrollback } = await import('../../src/utils/messages/fullscreenScrollback.ts')
const m = (id: string) => ({ uuid: id })
// Two prior compaction intervals already in scrollback, then a third boundary.
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
