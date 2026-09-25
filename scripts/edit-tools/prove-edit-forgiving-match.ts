#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'forgiving-match-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

const utils = (await import('../../src/tools/FileEditTool/utils.ts')) as unknown as {
  findActualString: (content: string, search: string) => string | null
  locateActualString?: (content: string, search: string) => Outcome
  preserveQuoteStyleForFile: (path: string, content: string, oldString: string, actual: string, newString: string) => Promise<string>
  FORGIVENESS_CONTENT_DRIFT_LIMIT?: number
}
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type Outcome =
  | { kind: 'found'; actual: string; index: number; road: string; startLine: number; endLine: number; feedback: string | null }
  | { kind: 'ambiguous'; road: string; count: number }
  | { kind: 'none' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — forgiving match proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const EN = '\u2013'
const EM = '\u2014'
const NBSP = '\u00A0'
const THIN = '\u2009'
const MINUS = '\u2212'
const RS = '\u2019'
const NOT_FOUND = 'The old_string was not found in the file.'
const AMBIGUOUS = /^Found (\d+) matches of the string to replace, but replace_all is false/
const locate = (content: string, search: string): Outcome =>
  typeof utils.locateActualString === 'function' ? utils.locateActualString(content, search) : { kind: 'none' }
const found = (outcome: Outcome): outcome is Extract<Outcome, { kind: 'found' }> => outcome.kind === 'found'
const show = (outcome: Outcome): string => JSON.stringify(outcome)

const fixtures = mkdtempSync(join(tmpdir(), 'forgiving-match-fixture-'))
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
function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, { content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), timestamp: Date.now() + 60_000 })
}
type EditResult = { ok: true; text: string } | { ok: false; error: string }
let fixtureCount = 0
async function edit(name: string, content: string, input: Record<string, unknown>): Promise<EditResult & { after: string; path: string }> {
  const path = join(fixtures, `${++fixtureCount}-${name}`)
  writeFileSync(path, content)
  const ctx = makeContext()
  primeRead(ctx, path)
  const full = { file_path: path, ...input }
  let result: EditResult
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(full, ctx)
  if (validation.result === false) {
    result = { ok: false, error: String(validation.message) }
  } else {
    try {
      const out = await (FileEditTool as { call: Function }).call(full, ctx, null, { uuid: '00000000-0000-0000-0000-000000000021', message: { id: 'msg_fixture' } })
      const block = (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_fixture')
      result = { ok: true, text: String(block.content) }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ...result, after: readFileSync(path, 'utf8'), path }
}
const detail = (r: EditResult): string => (r.ok ? `landed: ${r.text.slice(0, 120)}` : `refused: ${r.error.slice(0, 160)}`)

const FOUR = [
  'export function run(items: string[]): number {',
  '    let total = 0',
  '    for (const item of items) {',
  '        if (item.length > 0) {',
  '            total += item.length',
  '        }',
  '    }',
  '    return total',
  '}',
  '',
].join('\n')
const TWO_OLD = ['  for (const item of items) {', '    if (item.length > 0) {', '      total += item.length', '    }', '  }'].join('\n')
const TWO_NEW = ['  for (const item of items) {', '    if (item.length > 0) {', '      total += item.length', '      count += 1', '    }', '  }'].join('\n')
const FOUR_AFTER = FOUR.replace('            total += item.length\n', '            total += item.length\n            count += 1\n')

section('A. the unit ladder: each road returns the real slice, its lines and its road')
{
  const exact = locate(FOUR, '    return total')
  check('A1 an exact match takes the exact road with no feedback', found(exact) && exact.road === 'exact' && exact.actual === '    return total' && exact.feedback === null && exact.startLine === 8 && exact.endLine === 8, show(exact))
  const curly = `say ${RS}hi${RS} now\n`
  const quotes = locate(curly, "say 'hi' now")
  check('A2 a curly-quote match still takes the quote road silently (today\'s law kept)', found(quotes) && quotes.road === 'quotes' && quotes.actual === `say ${RS}hi${RS} now` && quotes.feedback === null, show(quotes))
  check('A2b findActualString answers the quote road as before', utils.findActualString(curly, "say 'hi' now") === `say ${RS}hi${RS} now`)
  const indented = locate(FOUR, TWO_OLD)
  check('A3 a two-space old_string finds the four-space block through the indentation road and the slice is the file\'s own bytes', found(indented) && indented.road === 'indentation' && indented.actual === FOUR.split('\n').slice(2, 7).join('\n') && FOUR.includes(indented.actual), show(indented))
  check('A4 the indentation road names the file\'s lines 3-7', found(indented) && indented.startLine === 3 && indented.endLine === 7, show(indented))
  check('A5 the feedback sentence names the indentation road, the lines and the two widths', found(indented) && indented.feedback === "Matched with the file's indentation at lines 3-7: the file indents with 4 spaces where old_string used 2 spaces.", found(indented) ? String(indented.feedback) : show(indented))
  check('A6 findActualString returns the same real slice for the callers that only take a string', utils.findActualString(FOUR, TWO_OLD) === FOUR.split('\n').slice(2, 7).join('\n'), String(utils.findActualString(FOUR, TWO_OLD)))
  const trailing = locate('const a = 1   \nconst b = 2\t\n', 'const a = 1\nconst b = 2')
  check('A7 trailing whitespace on the file\'s lines is forgiven on the whitespace road and the slice keeps it', found(trailing) && trailing.road === 'whitespace' && trailing.actual === 'const a = 1   \nconst b = 2\t' && trailing.feedback === "Matched with the file's trailing whitespace at lines 1-2.", show(trailing))
  const dashed = `notes:\nthe range 1${EN}9 and a pause${EM}here\nwith a${NBSP}fixed${THIN}gap and x${MINUS}y\n`
  const characters = locate(dashed, 'the range 1-9 and a pause-here\nwith a fixed gap and x-y')
  check('A8 ASCII dashes and spaces find the file\'s en dash, em dash, minus, no-break and thin spaces on the characters road; the slice keeps them', found(characters) && characters.road === 'characters' && characters.actual === `the range 1${EN}9 and a pause${EM}here\nwith a${NBSP}fixed${THIN}gap and x${MINUS}y`, show(characters))
  check('A9 the characters feedback sentence names the road and the lines', found(characters) && characters.feedback === "Matched with the file's dash/space characters at lines 2-3.", found(characters) ? String(characters.feedback) : show(characters))
  const both = locate(`    a ${EN} b\n    c\n`, '  a - b\n  c')
  check('A10 indentation and characters differing together take the indentation road and the sentence names both', found(both) && both.road === 'indentation' && both.actual === `    a ${EN} b\n    c` && both.feedback === "Matched with the file's indentation and dash/space characters at lines 1-2: the file indents with 4 spaces where old_string used 2 spaces.", show(both))
  const tabbed = locate('\tif (x) {\n\t\ty()\n\t}\n', '  if (x) {\n    y()\n  }')
  check('A11 a tab-indented file is found from a space-indented old_string and the slice keeps the tabs', found(tabbed) && tabbed.road === 'indentation' && tabbed.actual === '\tif (x) {\n\t\ty()\n\t}' && tabbed.feedback === "Matched with the file's indentation at lines 1-3: the file indents with 1 tab where old_string used 2 spaces.", show(tabbed))
  const newline = locate(FOUR, `${TWO_OLD}\n`)
  check('A12 an old_string ending in a newline matches the same lines and the slice carries the newline', found(newline) && newline.actual === `${FOUR.split('\n').slice(2, 7).join('\n')}\n` && newline.startLine === 3 && newline.endLine === 7, show(newline))
  const single = locate(FOUR, '\treturn total')
  check('A13 a one-line old_string with the wrong indentation finds its line', found(single) && single.actual === '    return total' && single.startLine === 8 && single.endLine === 8, show(single))
  const flat = locate(FOUR, 'let total = 0\n  for (const item of items) {')
  check('A14 a first line typed without its indentation still anchors on whole lines', found(flat) && flat.actual === '    let total = 0\n    for (const item of items) {', show(flat))
}

section('B. the refusals: content is never forgiven, the bound is zero content drift, and two different slices refuse')
{
  check('B0 the bound is one named constant and it is zero', utils.FORGIVENESS_CONTENT_DRIFT_LIMIT === 0, String(utils.FORGIVENESS_CONTENT_DRIFT_LIMIT))
  const content = locate(FOUR, TWO_OLD.replace('total += item.length', 'total -= item.length'))
  check('B1 an old_string that differs in content, not whitespace, is not found', content.kind === 'none', show(content))
  const nearMiss = locate(FOUR, TWO_OLD.replace('item.length > 0', 'item.length > 1'))
  check('B2 a one-character content drift inside a whitespace-different block is past the bound and refuses', nearMiss.kind === 'none', show(nearMiss))
  const lineCount = locate(FOUR, TWO_OLD.replace('    if (item.length > 0) {\n', ''))
  check('B3 a block whose line count differs from the file\'s block is not found', lineCount.kind === 'none', show(lineCount))
  const internal = locate(FOUR, TWO_OLD.replace('total += item.length', 'total  +=  item.length'))
  check('B4 whitespace inside a line is content, not indentation: it refuses', internal.kind === 'none', show(internal))
  const blank = locate(FOUR, '  \n    ')
  check('B5 a whitespace-only old_string takes no forgiving road', blank.kind === 'none' || (found(blank) && blank.road === 'exact'), show(blank))
  const twoBlocks = `${FOUR}\nexport function again(items: string[]): number {\n  let total = 0\n  for (const item of items) {\n    if (item.length > 0) {\n      total += item.length\n    }\n  }\n  return total\n}\n`
  const differing = locate(twoBlocks, '\tfor (const item of items) {\n\t\tif (item.length > 0) {\n\t\t\ttotal += item.length\n\t\t}\n\t}')
  check('B6 two blocks with different indentation both matching a tab-typed old_string refuse as ambiguous', differing.kind === 'ambiguous' && differing.count === 2, show(differing))
  check('B7 findActualString answers null for that ambiguity (a refusal, never a guess)', utils.findActualString(twoBlocks, '\tfor (const item of items) {\n\t\tif (item.length > 0) {\n\t\t\ttotal += item.length\n\t\t}\n\t}') === null)
  const dashes = locate(`a ${EN} b\na ${EM} b\n`, 'a - b')
  check('B8 two spellings of the same dashed line refuse as ambiguous on the characters road', dashes.kind === 'ambiguous' && dashes.count === 2, show(dashes))
  const same = locate(`a ${EN} b\na ${EN} b\n`, 'a - b')
  check('B9 two identical spellings return the slice and leave the count to the tool (today\'s replace_all law)', found(same) && same.actual === `a ${EN} b`, show(same))
}

section('C. through the tool: a two-space old_string against a four-space file lands with four spaces')
{
  const r = await edit('four.ts', FOUR, { old_string: TWO_OLD, new_string: TWO_NEW })
  check('C1 the edit lands', r.ok, detail(r))
  check('C2 the new line landed at the file\'s 12 spaces and every other byte stands', r.after === FOUR_AFTER, JSON.stringify(r.after))
  const wrapped = await edit('wrap.ts', FOUR, { old_string: '  let total = 0', new_string: '  let total = 0\n  let count = 0' })
  check('C3 guard: a one-line old_string that is an exact substring (shallower indentation) still takes the exact road and lands as typed', wrapped.ok && wrapped.after === FOUR.replace('    let total = 0\n', '    let total = 0\n  let count = 0\n'), detail(wrapped) + ' ' + JSON.stringify(wrapped.after))
  const flat = await edit('flat.ts', FOUR, { old_string: 'return total\n}', new_string: 'return total * 2\n}' })
  check('C4 guard: an old_string that is an exact substring from its first character lands as before', flat.ok && flat.after === FOUR.replace('    return total\n}', '    return total * 2\n}'), detail(flat) + ' ' + JSON.stringify(flat.after))
  const tabs = await edit('tabs.ts', '\tif (x) {\n\t\ty()\n\t}\n', { old_string: '  if (x) {\n    y()\n  }', new_string: '  if (x) {\n    y()\n    z()\n  }' })
  check('C5 a tab-indented file edited from a space-indented old_string keeps tabs on the new line', tabs.ok && tabs.after === '\tif (x) {\n\t\ty()\n\t\tz()\n\t}\n', detail(tabs) + ' ' + JSON.stringify(tabs.after))
  const trailing = await edit('trailing.ts', 'const a = 1   \nconst b = 2\t\nconst c = 3\n', { old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 1\nconst b = 20' })
  check('C6 trailing whitespace on the file\'s lines is forgiven and the untouched line keeps its trailing spaces', trailing.ok && trailing.after === 'const a = 1   \nconst b = 20\nconst c = 3\n', detail(trailing) + ' ' + JSON.stringify(trailing.after))
  const deleted = await edit('delete.ts', FOUR, { old_string: '  for (const item of items) {\n    if (item.length > 0) {\n      total += item.length\n    }\n  }\n', new_string: '' })
  check('C7 a deletion through the indentation road removes exactly the file\'s lines', deleted.ok && deleted.after === FOUR.replace('    for (const item of items) {\n        if (item.length > 0) {\n            total += item.length\n        }\n    }\n', ''), detail(deleted) + ' ' + JSON.stringify(deleted.after))
  const blankInside = await edit('blank-inside.ts', 'a\n    x\n\n    y\nb\n', { old_string: '  x\n\n  y\n', new_string: '' })
  check('C7b a deletion of a block with a blank line inside leaves no blank line behind', blankInside.ok && blankInside.after === 'a\nb\n', detail(blankInside) + ' ' + JSON.stringify(blankInside.after))
}

section('D. through the tool: the same old_string matching two blocks refuses as ambiguous, and nothing is written')
{
  const twin = `${FOUR}\n${FOUR}`
  const r = await edit('twin.ts', twin, { old_string: TWO_OLD, new_string: TWO_NEW })
  check('D1 the refusal uses today\'s ambiguity wording', !r.ok && AMBIGUOUS.test(r.error) && r.error.includes('Found 2 matches'), detail(r))
  check('D2 nothing was written', r.after === twin)
  const all = await edit('twin-all.ts', twin, { old_string: TWO_OLD, new_string: TWO_NEW, replace_all: true })
  check('D3 with replace_all both blocks land with the file\'s indentation', all.ok && all.after === `${FOUR_AFTER}\n${FOUR_AFTER}`, detail(all))
  const differing = `${FOUR}\nfunction again(items: string[]): number {\n  let total = 0\n  for (const item of items) {\n    if (item.length > 0) {\n      total += item.length\n    }\n  }\n  return total\n}\n`
  const typedWithTabs = await edit('differing.ts', differing, { old_string: '\tfor (const item of items) {\n\t\tif (item.length > 0) {\n\t\t\ttotal += item.length\n\t\t}\n\t}', new_string: '\tfor (const item of items) {\n\t\ttotal += 1\n\t}' })
  check('D4 two candidate blocks with different indentation refuse and write nothing', !typedWithTabs.ok && typedWithTabs.after === differing, detail(typedWithTabs))
}

section('E. through the tool: an old_string that differs in content keeps today\'s not-found refusal')
{
  const r = await edit('content.ts', FOUR, { old_string: TWO_OLD.replace('total += item.length', 'total -= item.length'), new_string: TWO_NEW })
  check('E1 the refusal is today\'s not-found wording', !r.ok && r.error.startsWith(NOT_FOUND), detail(r))
  check('E2 nothing was written', r.after === FOUR)
  const near = await edit('near.ts', FOUR, { old_string: TWO_OLD.replace('item.length > 0', 'item.length > 1'), new_string: TWO_NEW })
  check('E3 a near-miss past the zero-drift bound is refused with the not-found wording, not landed', !near.ok && near.error.startsWith(NOT_FOUND) && near.after === FOUR, detail(near))
}

section('F. through the tool: en dash, em dash and no-break space in the file, ASCII in old_string')
{
  const enFile = `# Range\n\nThe pages 10${EN}20 cover the setup.\nThe pages 30${EN}40 cover the run.\n`
  const en = await edit('en.md', enFile, { old_string: 'The pages 10-20 cover the setup.', new_string: 'The pages 10-20 cover the setup and the teardown.' })
  check('F1 an en dash line is found from ASCII and the edit lands', en.ok, detail(en))
  check('F2 the untouched part of the line keeps the en dash and the second line stands', en.after === `# Range\n\nThe pages 10${EN}20 cover the setup and the teardown.\nThe pages 30${EN}40 cover the run.\n`, JSON.stringify(en.after))
  const emFile = `notes${EM}first draft\nnotes${EM}second draft\n`
  const em = await edit('em.txt', emFile, { old_string: 'notes-second draft', new_string: 'notes-final draft' })
  check('F3 an em dash line is found from ASCII, the changed text lands as typed and the sibling line keeps its em dash', em.ok && em.after === `notes${EM}first draft\nnotes${EM}final draft\n`, detail(em) + ' ' + JSON.stringify(em.after))
  const nbspFile = `price: 10${NBSP}EUR\nweight: 2${NBSP}kg\n`
  const nbsp = await edit('nbsp.txt', nbspFile, { old_string: 'weight: 2 kg', new_string: 'weight: 3 kg' })
  check('F4 a no-break space line is found from an ASCII space; the changed digit lands and the untouched tail keeps the file\'s no-break space', nbsp.ok && nbsp.after === `price: 10${NBSP}EUR\nweight: 3${NBSP}kg\n`, detail(nbsp) + ' ' + JSON.stringify(nbsp.after).replaceAll(NBSP, '<NBSP>'))
  const nbspTyped = await edit('nbsp-typed.txt', nbspFile, { old_string: 'weight: 2 kg', new_string: 'weight: 2.5 kg net' })
  check('F4b a typed ASCII space inside the changed region lands as typed (new_string is never re-spelled)', nbspTyped.ok && nbspTyped.after === `price: 10${NBSP}EUR\nweight: 2.5 kg net\n`, detail(nbspTyped) + ' ' + JSON.stringify(nbspTyped.after).replaceAll(NBSP, '<NBSP>'))
  const keep = await edit('keep.ts', `const label = 'a ${EN} b ${EN} c'\n`, { old_string: "const label = 'a - b - c'", new_string: "const label = 'a - b - c -- d'" })
  check('F5 the untouched head of the slice keeps the file\'s dashes and the typed tail lands with its ASCII dashes', keep.ok && keep.after === `const label = 'a ${EN} b ${EN} c -- d'\n`, detail(keep) + ' ' + JSON.stringify(keep.after))
  const twoPositions = await edit('two.md', `a ${EN} b\nx\na ${EN} b\n`, { old_string: 'a - b', new_string: 'a - c' })
  check('F6 a two-position match on the characters road still refuses with today\'s ambiguity wording', !twoPositions.ok && AMBIGUOUS.test(twoPositions.error) && twoPositions.after === `a ${EN} b\nx\na ${EN} b\n`, detail(twoPositions))
  const mixed = await edit('mixed.md', `a ${EN} b\nx\na ${EM} b\n`, { old_string: 'a - b', new_string: 'a - c' })
  check('F7 two different spellings refuse and write nothing', !mixed.ok && mixed.after === `a ${EN} b\nx\na ${EM} b\n`, detail(mixed))
  const both = await edit('both.py', `class A:\n    def run(self):\n        return 1${MINUS}2\n`, { old_string: '  def run(self):\n    return 1-2', new_string: '  def run(self):\n    return 1-2\n\n  def stop(self):\n    return 0' })
  check('F8 indentation and a minus sign forgiven together: the untouched line keeps the minus, the new lines take the file\'s indentation', both.ok && both.after === `class A:\n    def run(self):\n        return 1${MINUS}2\n\n    def stop(self):\n        return 0\n`, detail(both) + ' ' + JSON.stringify(both.after))
}

section('G. the replacement builder keeps the file\'s spelling on untouched lines only')
{
  const actual = FOUR.split('\n').slice(2, 7).join('\n')
  const built = await utils.preserveQuoteStyleForFile(join(fixtures, 'x.ts'), FOUR, TWO_OLD, actual, TWO_NEW)
  check('G1 the untouched lines are the file\'s lines and the new line takes the dictionary indentation', built === ['    for (const item of items) {', '        if (item.length > 0) {', '            total += item.length', '            count += 1', '        }', '    }'].join('\n'), JSON.stringify(built))
  const novel = await utils.preserveQuoteStyleForFile(join(fixtures, 'x.ts'), FOUR, '  for (const item of items) {\n  }', '    for (const item of items) {\n    }', '  for (const item of items) {\n    if (item) {\n      deep()\n    }\n  }')
  check('G2 a new deeper level unknown to the block extends the deepest known indentation by the typed remainder', novel === '    for (const item of items) {\n      if (item) {\n        deep()\n      }\n    }', JSON.stringify(novel))
  const untouched = await utils.preserveQuoteStyleForFile(join(fixtures, 'x.ts'), 'abc', 'abc', 'ab', 'a"c')
  check('G3 a non-forgiving length mismatch still leaves the replacement untouched (the 1:1 helper\'s law)', untouched === 'a"c', JSON.stringify(untouched))
}

section('H. scale: the passes stay quick on a large file')
{
  const big = Array.from({ length: 60_000 }, (_, i) => `    const value${i} = compute(${i})`).join('\n') + '\n'
  const t0 = Date.now()
  const missing = locate(big, Array.from({ length: 40 }, (_, i) => `  const value${i} = compute(${i + 1})`).join('\n'))
  const t1 = Date.now()
  check('H1 a missing 40-line block over 60k lines answers none in under two seconds', missing.kind === 'none' && t1 - t0 < 2000, `${show(missing).slice(0, 80)} in ${t1 - t0}ms`)
  const present = locate(big, Array.from({ length: 40 }, (_, i) => `  const value${59_900 + i} = compute(${59_900 + i})`).join('\n'))
  const t2 = Date.now()
  check('H2 a present block near the end is found through the indentation road in under two seconds', found(present) && present.road === 'indentation' && present.startLine === 59_901 && t2 - t1 < 2000, `${show(present).slice(0, 120)} in ${t2 - t1}ms`)
  const nothing = utils.findActualString('a plain ascii line\nanother plain line\n', `${'ü'.repeat(70_000)}∅ never in the file`)
  check('H3 a very large non-ASCII miss is still a clean null', nothing === null)
}

rmSync(fixtures, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
