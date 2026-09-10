#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-modes-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

const { planAppend, findSection, planSectionEdit } = await import('../../src/tools/FileEditTool/sectionEdit.ts')
const { planHunks, formatHunkOutcomes } = await import('../../src/services/changeTransaction/hunks.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { fileGeneration, recordSeenLines } = await import('../../src/services/changeTransaction/seenLines.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — edit modes proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-modes-fixture-'))
type Ctx = { readFileState: Map<string, unknown> }
function makeContext(): Ctx {
  const readFileState = new Map<string, unknown>()
  return {
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
function primeRead(ctx: Ctx, path: string, window?: { offset: number; limit: number }): void {
  const full = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  const content = window ? full.split('\n').slice(window.offset - 1, window.offset - 1 + window.limit).join('\n') : full
  ctx.readFileState.set(path, {
    content,
    timestamp: Date.now() + 60_000,
    offset: window ? window.offset : undefined,
    limit: window ? window.limit : undefined,
  })
}
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true; data: Record<string, unknown>; effect: Record<string, unknown> } | { ok: false; error: string }> {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) return { ok: false, error: String(validation.message) }
  try {
    const result = await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } })
    return { ok: true, data: result.data, effect: result.effect }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
const RECEIPT = '# Receipt\n\n## Scope\n\n- one\n\n## Checks\n\n- typecheck 0\n- suite 0\n\n\n### `abc` — item\n\n- proof green\n\n## Next\n\n- item two\n'

section('P. the pure planner')
check('P1 append after a final newline', planAppend('a\n', 'b\n') === 'a\nb\n')
check('P2 append supplies the missing newline', planAppend('a', 'b') === 'a\nb')
check('P3 append to an empty file is the text', planAppend('', 'b\n') === 'b\n')
const checks = findSection(RECEIPT, '## Checks')
check('P4 a section runs from its heading to the line before the next peer heading', checks.ok && checks.start === 7 && checks.end === 16, JSON.stringify(checks))
const item = findSection(RECEIPT, '### `abc` — item')
check('P5 a deeper heading is inside its parent; its own section ends at the parent\'s next peer', item.ok && item.start === 13 && item.end === 16, JSON.stringify(item))
const next = findSection(RECEIPT, '## Next')
check('P6 the last section runs to the end of the file', next.ok && next.start === 17 && next.end === 19, JSON.stringify(next))
check('P7 trailing whitespace on the heading is ignored', findSection(RECEIPT, '## Next   ').ok)
check('P8 a missing heading refuses naming it', !findSection(RECEIPT, '## Nope').ok && (findSection(RECEIPT, '## Nope') as { message: string }).message.includes('"## Nope"'))
check('P9 a duplicated heading refuses with both lines', (() => {
  const r = findSection('## A\n\nx\n\n## A\n\ny\n', '## A')
  return !r.ok && r.message.includes('2 times') && r.message.includes('lines 1, 5')
})())
check('P10 a non-heading line refuses', !findSection(RECEIPT, '- one').ok)
const replaced = planSectionEdit(RECEIPT, '## Checks', { replace: '## Checks\n\n- all green\n' })
check('P11 replace swaps the whole section, heading included, and keeps the rest', replaced.ok && replaced.updated === '# Receipt\n\n## Scope\n\n- one\n\n## Checks\n\n- all green\n## Next\n\n- item two\n', replaced.ok ? JSON.stringify(replaced.updated) : replaced.message)
check('P12 …and reports the section text it replaced', replaced.ok && replaced.sectionText.startsWith('## Checks') && replaced.sectionText.includes('- proof green'))
const appended = planSectionEdit(RECEIPT, '## Checks', { append: '- build 0\n' })
check('P13 append inside a section lands after its last non-blank line, above the separating blanks', appended.ok && appended.updated.includes('- proof green\n- build 0\n\n## Next'), appended.ok ? JSON.stringify(appended.updated) : appended.message)
const appendedLast = planSectionEdit(RECEIPT, '## Next', { append: '- item three' })
check('P14 append inside the last section keeps the final-newline state', appendedLast.ok && appendedLast.updated.endsWith('- item two\n- item three\n'))
check('P15 an empty in-section append refuses', !planSectionEdit(RECEIPT, '## Next', { append: '' }).ok)
check('P16 a file without a final newline stays without one', (() => {
  const r = planSectionEdit('## A\nx', '## A', { replace: '## A\ny' })
  return r.ok && r.updated === '## A\ny'
})())

section('O. the hunks planner judges every hunk')
{
  const plan = planHunks('l1\nl2\nl3\n', [
    { lines: '1', replace: 'A' },
    { lines: '27', replace: 'B' },
    { lines: 'x', replace: 'C' },
    { lines: '3', replace: 'D' },
  ])
  check('O1 the refusal is the first failure', !plan.ok && plan.message === "hunk 2: lines '27' out of bounds — the file has 3 line(s)", plan.ok ? 'ok' : plan.message)
  check('O2 …and every hunk has an outcome', !plan.ok && plan.outcomes.length === 4 && plan.outcomes[0]!.ok && !plan.outcomes[1]!.ok && !plan.outcomes[2]!.ok && plan.outcomes[3]!.ok)
  check('O3 the outcome line names each hunk once, ok or its failure', !plan.ok && formatHunkOutcomes(plan.outcomes) === "hunk 1 (1): ok · hunk 2 (27): lines '27' out of bounds — the file has 3 line(s) · hunk 3 (x): lines 'x' does not parse — use \"N\" or \"N-M\" (1-based, inclusive) · hunk 4 (3): ok", plan.ok ? '' : formatHunkOutcomes(plan.outcomes))
  const overlap = planHunks('l1\nl2\nl3\n', [{ lines: '1-2', replace: 'A' }, { lines: '2', replace: 'B' }, { lines: '3', replace: 'C' }])
  check('O4 an overlap marks both hunks and leaves the third ok', !overlap.ok && overlap.outcomes.filter(o => !o.ok).length === 2 && overlap.outcomes[2]!.ok)
  const fine = planHunks('l1\nl2\nl3\n', [{ lines: '1', replace: 'A' }])
  check('O5 a sound plan is unchanged', fine.ok && fine.spans.length === 1)
}

section('L. append and section through the tool')
{
  const fresh = join(fixtures, 'new-receipt.md')
  const ctx = makeContext()
  const created = await edit({ file_path: fresh, append: '# Receipt\n' }, ctx)
  check('L1 append creates a missing file with no prior read', created.ok && readFileSync(fresh, 'utf8') === '# Receipt\n', created.ok ? '' : created.error)
  const extended = await edit({ file_path: fresh, append: '- first\n' }, makeContext())
  check('L2 append extends an existing file with no prior read', extended.ok && readFileSync(fresh, 'utf8') === '# Receipt\n- first\n', extended.ok ? '' : extended.error)
  check('L3 …with the append mode named in the effect', extended.ok && String(extended.effect.evidence).startsWith('append mode'))
  writeFileSync(fresh, '# Receipt\n- first')
  const noNl = await edit({ file_path: fresh, append: '- second\n' }, makeContext())
  check('L4 append after a file with no final newline starts its own line', noNl.ok && readFileSync(fresh, 'utf8') === '# Receipt\n- first\n- second\n')

  const receipt = join(fixtures, 'receipt.md')
  writeFileSync(receipt, RECEIPT)
  const ctx2 = makeContext()
  primeRead(ctx2, receipt)
  const inSection = await edit({ file_path: receipt, section: '## Checks', append: '- build 0\n' }, ctx2)
  check('L5 in-section append lands inside the section', inSection.ok && readFileSync(receipt, 'utf8').includes('- proof green\n- build 0\n\n## Next'), inSection.ok ? '' : inSection.error)
  const ctx3 = makeContext()
  primeRead(ctx3, receipt)
  const swapped = await edit({ file_path: receipt, section: '## Next', new_string: '## Next\n\n- nothing\n' }, ctx3)
  check('L6 section replace swaps the whole section', swapped.ok && readFileSync(receipt, 'utf8').endsWith('## Next\n\n- nothing\n'), swapped.ok ? '' : swapped.error)
  check('L7 …reporting the old section and the new text', swapped.ok && String(swapped.data.oldString).startsWith('## Next') && swapped.data.newString === '## Next\n\n- nothing\n')
  const before = readFileSync(receipt, 'utf8')
  const ctx4 = makeContext()
  primeRead(ctx4, receipt)
  const missing = await edit({ file_path: receipt, section: '## Nope', append: '- x\n' }, ctx4)
  check('L8 a missing heading refuses naming it and writes nothing', !missing.ok && missing.error.includes('"## Nope"') && missing.error.includes('Nothing was written') && readFileSync(receipt, 'utf8') === before)
  const both = await edit({ file_path: receipt, section: '## Next', append: 'a', new_string: 'b' }, ctx4)
  check('L9 section with both append and new_string refuses', !both.ok && both.error.includes('exactly one'))
  const clash = await edit({ file_path: receipt, append: 'a', old_string: 'x', new_string: 'y' }, ctx4)
  check('L10 append beside old_string refuses', !clash.ok && clash.error.includes('append stands alone'))
  const ctx5 = makeContext()
  primeRead(ctx5, receipt)
  const same = await edit({ file_path: receipt, section: '## Next', new_string: '## Next\n\n- nothing\n' }, ctx5)
  check('L11 a byte-identical section replace is a no-change settlement', same.ok && same.effect.outcome === 'no-change')

  const hunkFile = join(fixtures, 'hunks.txt')
  writeFileSync(hunkFile, 'l1\nl2\nl3\n')
  const ctx6 = makeContext()
  primeRead(ctx6, hunkFile)
  const batch = await edit({ file_path: hunkFile, expected_anchor: mintFileAnchor('l1\nl2\nl3\n'), hunks: [{ lines: '1', replace: 'A' }, { lines: '27', replace: 'B' }] }, ctx6)
  check('L12 a hunks batch with one bad hunk refuses with every outcome and writes nothing', !batch.ok && batch.error.includes('Outcomes: hunk 1 (1): ok · hunk 2 (27):') && batch.error.includes('Nothing was written') && readFileSync(hunkFile, 'utf8') === 'l1\nl2\nl3\n', batch.ok ? '' : batch.error)
}

section('K. read knowledge keyed to content')
{
  const file = join(fixtures, 'keyed.ts')
  const body = 'const a = 1\nconst b = 2\nconst c = 3\n'
  writeFileSync(file, body)
  const none = await edit({ file_path: file, old_string: 'const b = 2', new_string: 'const b = 20' }, makeContext())
  check('K1 no read, no anchor, no shown lines: refused with the content-keyed words', !none.ok && none.error.includes('Read the file before editing it') && none.error.includes('expected_anchor'), none.ok ? '' : none.error)
  const anchored = await edit({ file_path: file, old_string: 'const b = 2', new_string: 'const b = 20', expected_anchor: mintFileAnchor(body) }, makeContext())
  check('K2 no read but a matching full anchor edits', anchored.ok && readFileSync(file, 'utf8').includes('const b = 20'), anchored.ok ? '' : anchored.error)
  const stale = await edit({ file_path: file, old_string: 'const c = 3', new_string: 'const c = 30', expected_anchor: mintFileAnchor(body) }, makeContext())
  check('K3 a stale full anchor refuses typed', !stale.ok && stale.error.includes('Read the file before editing it'), stale.ok ? '' : stale.error)

  const shown = join(fixtures, 'shown.ts')
  writeFileSync(shown, body)
  recordSeenLines(processMainOwner(), shown, fileGeneration(shown)!, 3, 1)
  const seen = await edit({ file_path: shown, old_string: 'const c = 3', new_string: 'const c = 30' }, makeContext())
  check('K4 no read but the touched line shown for the current generation edits', seen.ok && readFileSync(shown, 'utf8').includes('const c = 30'), seen.ok ? '' : seen.error)
  const unseen = await edit({ file_path: shown, old_string: 'const a = 1', new_string: 'const a = 10' }, makeContext())
  check('K5 a line never shown still refuses', !unseen.ok && unseen.error.includes('Read the file before editing it'))
  writeFileSync(shown, 'const a = 1\nconst b = 2\nconst c = 300\n')
  const past = new Date(Date.now() - 120_000)
  utimesSync(shown, past, past)
  const drifted = await edit({ file_path: shown, old_string: 'const c = 300', new_string: 'const c = 3' }, makeContext())
  check('K6 a display recorded for an older generation no longer counts', !drifted.ok, drifted.ok ? 'edited' : '')

  const windowed = join(fixtures, 'windowed.ts')
  writeFileSync(windowed, body)
  const ctxW = makeContext()
  primeRead(ctxW, windowed, { offset: 2, limit: 1 })
  const inWindow = await edit({ file_path: windowed, old_string: 'const b = 2', new_string: 'const b = 22' }, ctxW)
  check('K7 a windowed read that showed the line edits it', inWindow.ok && readFileSync(windowed, 'utf8').includes('const b = 22'), inWindow.ok ? '' : inWindow.error)
  check('K8 the file size is what statSync says (no torn write)', statSync(windowed).size === Buffer.byteLength(readFileSync(windowed, 'utf8')))
  const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
  for (const priorRead of [false, true]) {
    const searched = join(fixtures, `searched-${priorRead}.ts`)
    writeFileSync(searched, body)
    const ctx = makeContext()
    if (priorRead) ctx.readFileState.set(searched, { content: 'old bytes', timestamp: 0 })
    const result = await GrepTool.call({ path: searched, pattern: 'const b = 2', output_mode: 'content' }, ctx as never)
    check('K9 single-file Grep actually displays the current line', result.data.content?.includes('const b = 2') === true)
    const changed = await edit({ file_path: searched, old_string: 'const b = 2', new_string: 'const b = 21' }, ctx)
    check('K10 current Grep evidence works with or without an obsolete Read', changed.ok && readFileSync(searched, 'utf8').includes('const b = 21'), changed.ok ? '' : changed.error)
  }
  const repeated = join(fixtures, 'repeated.ts')
  const repeatedBody = 'needle\nnot shown\nneedle\n'
  writeFileSync(repeated, repeatedBody)
  const repeatContext = makeContext()
  await GrepTool.call({ path: repeated, pattern: 'needle', output_mode: 'content', head_limit: 1 }, repeatContext as never)
  const repeatInput = { file_path: repeated, old_string: 'needle', new_string: 'changed', replace_all: true }
  const refused = await edit(repeatInput, repeatContext)
  check('K13 paged sight of the first match cannot authorize replace-all', !refused.ok && readFileSync(repeated, 'utf8') === repeatedBody)
  let executionRefused = false
  try { await (FileEditTool as { call: Function }).call(repeatInput, repeatContext) } catch { executionRefused = true }
  check('K14 execution independently checks every replacement range', executionRefused && readFileSync(repeated, 'utf8') === repeatedBody)
  const windowOnly = makeContext()
  primeRead(windowOnly, repeated, { offset: 1, limit: 1 })
  const windowAll = await edit(repeatInput, windowOnly)
  check('K15 a one-match Read window cannot authorize replace-all', !windowAll.ok && readFileSync(repeated, 'utf8') === repeatedBody)
  await GrepTool.call({ path: repeated, pattern: 'needle', output_mode: 'content' }, repeatContext as never)
  const allSeen = await edit(repeatInput, repeatContext)
  check('K16 sight of every match authorizes replace-all without unrelated lines', allSeen.ok && readFileSync(repeated, 'utf8') === 'changed\nnot shown\nchanged\n', allSeen.ok ? '' : allSeen.error)
  const oldRead = makeContext()
  oldRead.readFileState.set(windowed, { content: 'old bytes', timestamp: 0 })
  const currentAnchor = await edit({ file_path: windowed, old_string: 'const b = 22', new_string: 'const b = 23', expected_anchor: mintFileAnchor(readFileSync(windowed, 'utf8')) }, oldRead)
  check('K11 a current full anchor is independent of an obsolete Read', currentAnchor.ok, currentAnchor.ok ? '' : currentAnchor.error)
  oldRead.readFileState.set(windowed, { content: 'old bytes', timestamp: 0 })
  const appended = await edit({ file_path: windowed, append: '// appended\n' }, oldRead)
  check('K12 append is independent of obsolete read state', appended.ok && readFileSync(windowed, 'utf8').endsWith('// appended\n'), appended.ok ? '' : appended.error)
}

section('N. the tool-input normaliser keeps every mode')
{
  const { normalizeToolInput } = await import('../../src/utils/api.ts')
  const hunks = normalizeToolInput(FileEditTool as never, { file_path: join(fixtures, 'n.md'), hunks: [{ lines: '1', replace: 'a' }], expected_anchor: 'fa:000000000000' }) as Record<string, unknown>
  check('N1 hunks and expected_anchor ride through', Array.isArray(hunks.hunks) && hunks.expected_anchor === 'fa:000000000000' && hunks.old_string === undefined, JSON.stringify(hunks))
  const appended = normalizeToolInput(FileEditTool as never, { file_path: join(fixtures, 'n.md'), section: '## A', append: 'x' }) as Record<string, unknown>
  check('N2 section and append ride through', appended.section === '## A' && appended.append === 'x' && !('old_string' in appended), JSON.stringify(appended))
  const exact = normalizeToolInput(FileEditTool as never, { file_path: join(fixtures, 'n.md'), old_string: 'a', new_string: 'b' }) as Record<string, unknown>
  check('N3 the exact mode keeps its shape', exact.old_string === 'a' && exact.new_string === 'b' && exact.replace_all === false)
  const grep = readFileSync(join(import.meta.dir, '..', '..', 'src/tools/GrepTool/GrepTool.ts'), 'utf8')
  check('N4 a content-mode search records the displayed lines by default (not only under the opt-in dialect)', grep.includes("(anchorPatchEnabled() || staleEditRecoveryEnabled()) && (input['-n'] ?? true)"))
}

section('R. empty optional fields do not select or conflict with an edit mode')
{
  const body = '# Fixture\n\n## Target\nold\n\n## Other\nstay\n'
  const empty = { old_string: '', new_string: '', replace_all: false, expected_anchor: '', hunks: [], append: '', section: '' }
  const cases: Array<{ name: string; input: Record<string, unknown>; expected: string; mode: string }> = [
    { name: 'recorded section shape', input: { section: '## Target', new_string: '## Target\nnew\n' }, expected: '# Fixture\n\n## Target\nnew\n## Other\nstay\n', mode: 'section' },
    { name: 'append', input: { append: 'added\n' }, expected: body + 'added\n', mode: 'append' },
    { name: 'section append', input: { section: '## Target', append: 'added\n' }, expected: '# Fixture\n\n## Target\nold\nadded\n\n## Other\nstay\n', mode: 'section' },
    { name: 'hunks', input: { hunks: [{ lines: '4', replace: 'new' }], expected_anchor: mintFileAnchor(body) }, expected: body.replace('old', 'new'), mode: 'hunks' },
    { name: 'exact', input: { old_string: 'old', new_string: 'new' }, expected: body.replace('old', 'new'), mode: 'exact' },
    { name: 'exact deletion', input: { old_string: 'old', new_string: '' }, expected: body.replace('old\n', ''), mode: 'exact' },
    { name: 'section deletion', input: { section: '## Target', new_string: '' }, expected: '# Fixture\n\n## Other\nstay\n', mode: 'section' },
    { name: 'hunk deletion', input: { hunks: [{ lines: '4', replace: '' }], expected_anchor: mintFileAnchor(body) }, expected: '# Fixture\n\n## Target\n\n## Other\nstay\n', mode: 'hunks' },
    { name: 'whitespace append', input: { append: '  ' }, expected: body + '  ', mode: 'append' },
  ]
  for (const [index, row] of cases.entries()) {
    const file = join(fixtures, `empty-fields-${index}.md`)
    writeFileSync(file, body)
    const context = makeContext()
    primeRead(context, file)
    const input = { file_path: file, ...empty, ...row.input }
    const result = await edit(input, context)
    check(`R ${row.name}: the real tool applies its intended mode`, result.ok && readFileSync(file, 'utf8') === row.expected, result.ok ? JSON.stringify(readFileSync(file, 'utf8')) : result.error)
    check(`R ${row.name}: the effect names that mode`, result.ok && String(result.effect.evidence).includes(row.mode === 'hunks' ? 'anchored hunk' : row.mode), result.ok ? String(result.effect.evidence) : result.error)
    if (result.ok && row.mode !== 'hunks') check(`R ${row.name}: an empty anchor is not reported as checked`, (result.effect.details as { anchorChecked?: boolean } | undefined)?.anchorChecked === false)
    if (result.ok && row.mode === 'section' && row.input.new_string !== undefined) check(`R ${row.name}: the returned replacement is not the empty append placeholder`, result.data.newString === row.input.new_string)
  }
  const file = join(fixtures, 'empty-fields-refusals.md')
  writeFileSync(file, body)
  const context = makeContext()
  primeRead(context, file)
  const sectionOne = { file_path: file, ...empty, section: '## Target', new_string: 'one' }
  const sectionTwo = { ...sectionOne, new_string: 'two' }
  check('R empty mode fields compare like absent fields', FileEditTool.inputsEquivalent!(sectionOne as never, { file_path: file, section: '## Target', new_string: 'one' } as never) === true)
  check('R empty hunks cannot make different section edits equivalent', FileEditTool.inputsEquivalent!(sectionOne as never, sectionTwo as never) === false)
  const allEmpty = await FileEditTool.validateInput!({ file_path: file, ...empty } as never, context as never)
  check('R all empty fields use the existing empty-old-string refusal', allEmpty.result === false && allEmpty.errorCode === 3, JSON.stringify(allEmpty))
  for (const conflict of [
    { section: '## Target', new_string: 'new', old_string: 'old' },
    { section: '## Target', new_string: 'new', append: 'added' },
    { append: 'added', new_string: 'new' },
    { hunks: [{ lines: '4', replace: 'new' }], expected_anchor: mintFileAnchor(body), section: '## Target' },
    { hunks: [{ lines: '4', replace: 'new' }], expected_anchor: mintFileAnchor(body), append: 'added' },
    { hunks: [{ lines: '4', replace: 'new' }], expected_anchor: mintFileAnchor(body), old_string: 'old' },
    { section: '## Target', new_string: 'new', replace_all: true },
  ]) {
    const refused = await edit({ file_path: file, ...empty, ...conflict }, context)
    check('R meaningful mode conflicts still refuse without changing the file', !refused.ok && readFileSync(file, 'utf8') === body, refused.ok ? 'unexpected write' : refused.error)
  }
  const malformed = await edit({ file_path: file, ...empty, old_string: 'old', new_string: 'new', expected_anchor: 'not-an-anchor' }, context)
  check('R a nonempty malformed anchor still refuses', !malformed.ok && readFileSync(file, 'utf8') === body)
  const unread = await edit({ file_path: file, ...empty, section: '## Target', new_string: 'changed' }, makeContext())
  check('R empty placeholders confer no read knowledge', !unread.ok && unread.error.includes('Read the file'))
  const stale = await edit({ file_path: file, ...empty, old_string: 'old', new_string: 'new', expected_anchor: mintFileAnchor(body + 'drift') }, context)
  check('R a nonempty stale anchor is still checked', !stale.ok && readFileSync(file, 'utf8') === body)
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
