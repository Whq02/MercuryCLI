#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'quote-match-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS

const { findSection, planSectionEdit } = await import('../../src/tools/FileEditTool/sectionEdit.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const grepModule = (await import('../../src/tools/GrepTool/GrepTool.ts')) as unknown as {
  GrepTool: { call: Function }
  quoteTolerantPattern?: (pattern: string) => string
}
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
  console.log('\nTIMEOUT — quote-tolerant match proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const LS = '‘'
const RS = '’'
const LD = '“'
const RD = '”'
const fixtures = mkdtempSync(join(tmpdir(), 'quote-match-fixture-'))
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
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) return { ok: false, error: String(validation.message) }
  try {
    const result = await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000007', message: { id: 'msg_fixture' } })
    return { ok: true, data: result.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const NOTES = `# Notes\n\n## Don${RS}t stop\n\n- one\n\n## ${LD}Quoted${RD} heading\n\n- two\n\n## Plain\n\n- three\n`
const BOTH = `# Notes\n\n## Don't stop\n\n- straight\n\n## Don${RS}t stop\n\n- curly\n`

section('S. the section matcher: a curly heading in the file is found from a straight spelling')
{
  const straight = findSection(NOTES, "## Don't stop")
  check('S1 a straight apostrophe finds the curly heading and its section', straight.ok && straight.start === 3 && straight.end === 6, JSON.stringify(straight))
  const doubles = findSection(NOTES, '## "Quoted" heading')
  check('S2 straight double quotes find the curly-quoted heading', doubles.ok && doubles.start === 7 && doubles.end === 10, JSON.stringify(doubles))
  const curly = findSection(NOTES, `## Don${RS}t stop`)
  check('S3 the curly spelling still finds the curly heading', curly.ok && curly.start === 3, JSON.stringify(curly))
  const exactStraight = findSection(BOTH, "## Don't stop")
  const exactCurly = findSection(BOTH, `## Don${RS}t stop`)
  check('S4 when both spellings stand in the file, each spelling finds its own heading and neither refuses as a duplicate', exactStraight.ok && exactStraight.start === 3 && exactCurly.ok && exactCurly.start === 7, `${JSON.stringify(exactStraight)} ${JSON.stringify(exactCurly)}`)
  const missing = findSection(NOTES, "## Won't")
  check('S5 a heading in neither spelling still refuses naming it as typed', !missing.ok && (missing as { message: string }).message.includes(`"## Won't"`), JSON.stringify(missing))
  const appended = planSectionEdit(NOTES, "## Don't stop", { append: '- added\n' })
  check('S6 an in-section append through the straight spelling lands inside the curly section and leaves the heading bytes curly', appended.ok && appended.updated === `# Notes\n\n## Don${RS}t stop\n\n- one\n- added\n\n## ${LD}Quoted${RD} heading\n\n- two\n\n## Plain\n\n- three\n`, appended.ok ? JSON.stringify(appended.updated) : appended.message)
  const replaced = planSectionEdit(NOTES, '## "Quoted" heading', { replace: '## "Quoted" heading\n\n- new\n' })
  check('S7 a section replace through the straight spelling swaps the curly-headed section, heading included', replaced.ok && replaced.updated === `# Notes\n\n## Don${RS}t stop\n\n- one\n\n## "Quoted" heading\n\n- new\n## Plain\n\n- three\n`, replaced.ok ? JSON.stringify(replaced.updated) : replaced.message)
}

section('T. the section mode through the Edit tool')
{
  const notes = join(fixtures, 'notes.md')
  writeFileSync(notes, NOTES)
  const ctx = makeContext()
  primeRead(ctx, notes)
  const appended = await edit({ file_path: notes, section: "## Don't stop", append: '- added\n' }, ctx)
  check('T1 an in-section append from the straight spelling lands inside the curly section', appended.ok && readFileSync(notes, 'utf8').includes(`## Don${RS}t stop\n\n- one\n- added\n\n## `), appended.ok ? readFileSync(notes, 'utf8') : appended.error)
  writeFileSync(notes, NOTES)
  const unread = await edit({ file_path: notes, section: "## Don't stop", new_string: "## Don't stop\n\n- swapped\n" }, makeContext())
  check('T2 without a prior read the refusal names the curly section\'s lines, found from the straight spelling', !unread.ok && unread.error.includes('the edit touches lines 3-6') && !unread.error.includes('heading was not found'), unread.ok ? 'edited' : unread.error)
  check('T3 …and wrote nothing', readFileSync(notes, 'utf8') === NOTES)
}

section('G. the Grep pattern: a straight quote widens to its curly twins; a curly quote and a class stay as typed')
{
  const qt = grepModule.quoteTolerantPattern
  check('G0 quoteTolerantPattern is exported by the Grep tool', typeof qt === 'function')
  const tolerant = (p: string): string => (typeof qt === 'function' ? qt(p) : p)
  check("G1 a straight apostrophe becomes the class of itself and its curly twins", tolerant("don't") === `don['${LS}${RS}]t`, tolerant("don't"))
  check('G2 straight double quotes likewise', tolerant('"x"') === `["${LD}${RD}]x["${LD}${RD}]`, tolerant('"x"'))
  check('G3 an escaped quote is left to the engine', tolerant("it\\'s") === "it\\'s", tolerant("it\\'s"))
  check('G4 a quote inside a character class stays as typed', tolerant("[a-z']+") === "[a-z']+", tolerant("[a-z']+"))
  check('G5 a curly quote typed on purpose stays itself', tolerant(`don${RS}t`) === `don${RS}t`, tolerant(`don${RS}t`))
  check('G6 a pattern without quotes is the same string', tolerant('needle') === 'needle')
  check('G7 the literal ] opening a negated class is kept inside the class; the quote after the class widens', tolerant("[^]']x'") === `[^]']x['${LS}${RS}]`, tolerant("[^]']x'"))
  check('G8 a nested class closes at its own bracket', tolerant("[a[b]']'") === `[a[b]']['${LS}${RS}]`, tolerant("[a[b]']'"))
}

section('H. the Grep tool over a scratch tree: a curly line is found from a straight pattern')
{
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quote-grep-')))
  writeFileSync(join(dir, 'a.md'), `she said ${LD}hello${RD}\nthey don${RS}t know\nplain line\n`)
  writeFileSync(join(dir, 'b.txt'), "don't stop\nits fine\n")
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never
  type Data = { numFiles: number; filenames: string[]; content?: string; numLines?: number; numMatches?: number; incomplete?: string }
  const grep = async (input: Record<string, unknown>): Promise<Data> => ((await grepModule.GrepTool.call(input, context)) as { data: Data }).data
  const lines = await grep({ pattern: "don't", path: dir, output_mode: 'content' })
  check('H1 a straight apostrophe finds the curly line and the straight line', lines.numLines === 2 && (lines.content ?? '').includes(`don${RS}t know`) && (lines.content ?? '').includes("don't stop"), JSON.stringify(lines))
  const doubles = await grep({ pattern: '"hello"', path: dir, output_mode: 'content' })
  check('H2 straight double quotes find the curly-quoted word', doubles.numLines === 1 && (doubles.content ?? '').includes(`${LD}hello${RD}`), JSON.stringify(doubles))
  const curly = await grep({ pattern: `don${RS}t`, path: dir, output_mode: 'content' })
  check('H3 a curly pattern typed on purpose finds the curly line only', curly.numLines === 1 && (curly.content ?? '').includes(`don${RS}t know`), JSON.stringify(curly))
  const files = await grep({ pattern: "don't", path: dir })
  check('H4 files_with_matches lists both files', files.numFiles === 2, JSON.stringify(files))
  const folded = await grep({ pattern: "DON'T", path: dir, output_mode: 'content', '-i': true })
  check('H5 case folding still applies across the widened class', folded.numLines === 2, JSON.stringify(folded))
  const none = await grep({ pattern: "it's", path: dir })
  check('H6 no line is invented: a pattern absent in both spellings finds nothing', none.numFiles === 0, JSON.stringify(none))
  const counted = await grep({ pattern: "don't", path: dir, output_mode: 'count' })
  check('H7 count mode tallies both lines', counted.numMatches === 2, JSON.stringify(counted))
  check('H8 every walk finished', [lines, doubles, curly, files, folded, none, counted].every(d => d.incomplete === undefined))
  rmSync(dir, { recursive: true, force: true })
}

rmSync(fixtures, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
