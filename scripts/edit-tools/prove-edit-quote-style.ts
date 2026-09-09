#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-quote-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

const { preserveQuoteStyle, normalizeQuotes, findActualString, LEFT_DOUBLE_CURLY_QUOTE, RIGHT_DOUBLE_CURLY_QUOTE, LEFT_SINGLE_CURLY_QUOTE, RIGHT_SINGLE_CURLY_QUOTE } = await import('../../src/tools/FileEditTool/utils.ts')
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
  console.log('\nTIMEOUT — edit quote-style proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const LD = LEFT_DOUBLE_CURLY_QUOTE
const RD = RIGHT_DOUBLE_CURLY_QUOTE
const LS = LEFT_SINGLE_CURLY_QUOTE
const RS = RIGHT_SINGLE_CURLY_QUOTE
const count = (text: string, char: string): number => text.split(char).length - 1
const curlyCount = (text: string): number => count(text, LD) + count(text, RD) + count(text, LS) + count(text, RS)
const straightCount = (text: string): number => count(text, '"') + count(text, "'")

const MIXED = [
  "import { warn } from './warn'",
  'const label = "ceiling"',
  `const warning = ${LD}A ceiling of 1 keeps the main conversation${RS}s session only${RD}`,
  `const hint = ${LS}re-read the wider range first${RS}`,
  'const before = 1',
  "const after = before + 1 // 'kept'",
  `const prose = ${LD}quoted${RD} + label`,
  '',
].join('\n')

section('Q. the pure helper: the file keeps its bytes outside the change')
{
  const typed = normalizeQuotes(MIXED)
  check('Q0 the fixture normalises to a different, same-length string', typed !== MIXED && typed.length === MIXED.length && curlyCount(MIXED) === 7)
  const edited = typed.replace('const before = 1', 'const before = 2')
  const result = preserveQuoteStyle(typed, MIXED, edited)
  const expected = MIXED.replace('const before = 1', 'const before = 2')
  check('Q1 a whole-file match with one code line changed changes that line only (the owner-reported case)', result === expected, JSON.stringify(result).slice(0, 300))
  check('Q2 every curly quote of the file survives byte for byte', curlyCount(result) === curlyCount(MIXED) && result.includes(`${LD}A ceiling of 1 keeps the main conversation${RS}s session only${RD}`))
  check('Q3 every straight quote of the code survives (none became typographic)', straightCount(result) === straightCount(MIXED))
  const codeQuotes = typed.replace("const after = before + 1 // 'kept'", 'const after = before + 2 // "kept" and \'kept\'')
  const codeResult = preserveQuoteStyle(typed, MIXED, codeQuotes)
  check('Q4 new straight quotes on a code line stay straight when that line held none', codeResult.includes('const after = before + 2 // "kept" and \'kept\'') && curlyCount(codeResult) === curlyCount(MIXED))
  const proseEdit = typed.replace('re-read the wider range first', 'read the "whole" range first, it\'s wider')
  const proseResult = preserveQuoteStyle(typed, MIXED, proseEdit)
  check('Q5 new quotes inside a line that holds curly quotes take the file\'s style', proseResult.includes(`${LS}read the ${LD}whole${RD} range first, it${RS}s wider${RS}`), JSON.stringify(proseResult).slice(0, 300))
  const inserted = typed.replace(`const prose = "quoted" + label`, `const prose = "quoted" + "more" + label`)
  const insertedResult = preserveQuoteStyle(typed, MIXED, inserted)
  check('Q6 an insertion beside curly text on the same line takes the file\'s style', insertedResult.includes(`const prose = ${LD}quoted${RD} + ${LD}more${RD} + label`), JSON.stringify(insertedResult).slice(0, 300))
  const literal = preserveQuoteStyle(MIXED, MIXED, MIXED.replace(`${LD}quoted${RD}`, `${LD}quoted${RD} + "again"`))
  check('Q7 a literal match (the model typed curly quotes itself) still styles new prose on that line', literal.includes(`${LD}quoted${RD} + ${LD}again${RD}`))
  const plain = 'const a = "x"\nconst b = \'y\'\n'
  check('Q8 a file without curly quotes comes back byte-identical to the typed replacement', preserveQuoteStyle(plain, plain, plain.replace('"x"', '"z"')) === plain.replace('"x"', '"z"'))
  check('Q9 a length mismatch leaves the replacement untouched', preserveQuoteStyle('abc', 'ab', 'a"c') === 'a"c')
  const single = `${LS}quoted${RS} said the line\n`
  const singleTyped = normalizeQuotes(single)
  const singleResult = preserveQuoteStyle(singleTyped, single, `'quoted' said the line, that's 'all'\n`)
  check('Q10 single quotes: a contraction closes, a pair opens and closes', singleResult === `${LS}quoted${RS} said the line, that${RS}s ${LS}all${RS}\n`, JSON.stringify(singleResult))
  const shrunk = preserveQuoteStyle(typed, MIXED, typed.replace('const before = 1\n', ''))
  check('Q11 a deletion keeps the bytes around it', shrunk === MIXED.replace('const before = 1\n', ''))
  const grown = preserveQuoteStyle(typed, MIXED, typed + 'const tail = "z"\n')
  check('Q12 an appended code line after the file keeps straight quotes', grown === MIXED + 'const tail = "z"\n', JSON.stringify(grown.slice(-30)))
}

section('R. through the real tool: a whole-file edit on a mixed file')
{
  const fixtures = mkdtempSync(join(tmpdir(), 'edit-quote-fixture-'))
  const file = join(fixtures, 'Config.tsx')
  writeFileSync(file, MIXED)
  const ctx = {
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  }
  ctx.readFileState.set(file, { content: readFileSync(file, 'utf8'), timestamp: Date.now() + 60_000 })
  const typed = normalizeQuotes(MIXED)
  check('R0 the typed whole file matches the file only through quote normalisation', findActualString(MIXED, typed) === MIXED && !MIXED.includes(typed))
  const input = { file_path: file, old_string: typed, new_string: typed.replace('const before = 1', 'const before = 2') }
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  check('R1 the edit validates', validation.result !== false, String(validation.message ?? ''))
  let error = ''
  try {
    await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000004', message: { id: 'msg_fixture' } })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  check('R2 the edit applies', error === '', error)
  const after = readFileSync(file, 'utf8')
  check('R3 the file differs from its original at the edited line only', after === MIXED.replace('const before = 1', 'const before = 2'), JSON.stringify(after).slice(0, 300))
  check('R4 the typographic UI text and the code quotes both survive', curlyCount(after) === curlyCount(MIXED) && straightCount(after) === straightCount(MIXED))
}

console.log(`\n${failures === 0 ? 'EDIT QUOTE STYLE GREEN' : `${failures} EDIT QUOTE STYLE FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
