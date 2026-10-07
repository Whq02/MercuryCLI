#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-result-shows-change-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.NODE_ENV

const { _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const editResult = (await import('../../src/tools/FileEditTool/editResult.ts').catch(() => null)) as null | {
  buildEditedLines: (input: Record<string, unknown>) => Promise<{ editedLines: Record<string, unknown>; windows: unknown[] }>
  EDIT_RESULT_CLOSE: string
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 900 ? `${detail.slice(0, 900)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the result-shows-change proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-result-shows-change-fixture-'))
type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry>; userModifiedInput?: boolean }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, Entry>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000031', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string; isError: boolean; data: Record<string, unknown> } | { ok: false; message: string; code?: number }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx, id: string): Promise<Verdict> {
  const t = tool as { validateInput?: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  if (t.validateInput) {
    const verdict = await t.validateInput(input, ctx)
    if (verdict.result === false) return { ok: false, message: String(verdict.message), code: verdict.errorCode }
  }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, id)
    return { ok: true, text: typeof block.content === 'string' ? block.content : '', isError: block.is_error === true, data: out.data }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const edit = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileEditTool, input, ctx, 'toolu_edit')
const read = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileReadTool, input, ctx, 'toolu_read')
const textOf = (v: Verdict): string => (v.ok ? v.text : v.message)
const rowsOf = (text: string): string[] => text.split('\n').filter(line => /^\d+\t/.test(line))
const CLOSE = 'Checking this edit needs no Read; Read only lines this result does not show.'

const J = [
  '"""Connection helpers for the drive."""',
  '',
  '',
  'def connect(host):',
  '    retries = 3',
  '    return open_socket(host, retries)',
  '',
  '',
  'def reconnect(host, wait):',
  '    if wait:',
  '        retries = 3',
  '        return open_socket(host, retries)',
  '    return None',
  '',
  '',
  'def open_socket(host, retries):',
  '    return (host, retries)',
  '',
].join('\n')
const F = 'alpha\nbeta\ngamma\n'
const CONFIG = 'TIMEOUT = 30\nRETRIES = 3\n\ndef load():\n    timeout = TIMEOUT\n    return timeout\n\ndef save():\n    timeout = TIMEOUT\n    return timeout\n'
const B_CONSTANTS = [665,492,719,284,981,293,202,76,67,261,845,553,342,259,382,855,835,413,188,254,932,246,503,842,74,748,940,653,587,670,81,626,859,436,794,428,758,54,674,451,359,13,866,998,836,659,490,260,141,628,963,346,625,666,233,722,835,537,145,102,402,770,310,934,768,815,954,39,795,697,544,87,175,471,725,156,272,554,53,178,999,992,666,16,463,799,155,355,912,588,589,426,67,316,449,894,836,479,362,13,370,161,801,272,182,495,366,900,529,63,530,256,175,213,783,753,501,570,94,343,347,783,59,403,352,652,118,310,261,816,570,713,707,85,308,468,475,292,526,121,600,24,929,292,222,906,792,490,568,556,917,992,702,124,4,607,59,382,817,195,304,717,629,876,100,33,576,434,421,764,472,755,4,186,918,983,865,361,760,15,636,195,233,391,197,859,765,338,851,393,847,902,65,354,44,188,65,873,81,302,239,141,973,474,620,845,489,105,239,610,378,877,288,32,675,503,166,320,548,479,219,852,448,824,312,687,209,522,837,830,154,736,733,341,583,709,60,923,233,128,481,623,631,623,717,82,250,445,326,314,45,130,106,411,911,89,384,943,210,170,772,559,755,727,980,21,192,964,455,942,52,595,612,534,839,872,455,617,52,228,288,953,554,208,97,572,613,560,785,455,375,338,651,515,214,402,713,196,166,9,359,247,534,206,744,330,931,987,390,482,347,68,251,610,76,597,784,751,892,50,714,815,648,134,49,852,620,502,558,96,459,107]
function bBig(): string {
  const lines = ['# generated module for the search-then-edit drive', 'import math', '']
  for (let n = 1; n <= 332; n++) {
    lines.push(`def compute_${String(n).padStart(3, '0')}(x):`, `    """Return the value of step ${n}."""`, `    y = x * ${n} + ${B_CONSTANTS[n - 1]}`, '    return math.floor(y)', '', '')
  }
  lines.splice(1200, 0, 'LEGACY_THRESHOLD = 4096  # the one constant the drive must change')
  return lines.join('\n') + '\n'
}

const EXPECTED_J = (path: string): string => [
  `The file ${path} has been updated successfully: 1 occurrence replaced; changed line 11 (the file has 17 lines).`,
  'Lines 8-14 as read back right after the write; they count as read:',
  '8\t',
  '9\tdef reconnect(host, wait):',
  '10\t    if wait:',
  '11\t        retries = 5',
  '12\t        return open_socket(host, retries)',
  '13\t    return None',
  '14\t',
  '(anchor: ra:ed9338b863cf:L8+7)',
  CLOSE,
].join('\n')
const EXPECTED_F = (path: string): string => [
  `The file ${path} has been updated successfully: appended at the end; added line 4 (the file has 4 lines).`,
  'The whole file as read back right after the write; it counts as read:',
  '1\talpha',
  '2\tbeta',
  '3\tgamma',
  '4\tdelta',
  '(anchor: fa:927c9bb49935)',
  CLOSE,
].join('\n')
const EXPECTED_A = (path: string): string => [
  `The file ${path} has been updated successfully: all 3 occurrences replaced; changed lines 1, 5, 9 (the file has 10 lines).`,
  'The whole file as read back right after the write; it counts as read:',
  '1\tREQUEST_TIMEOUT = 30',
  '2\tRETRIES = 3',
  '3\t',
  '4\tdef load():',
  '5\t    timeout = REQUEST_TIMEOUT',
  '6\t    return timeout',
  '7\t',
  '8\tdef save():',
  '9\t    timeout = REQUEST_TIMEOUT',
  '10\t    return timeout',
  '(anchor: fa:e1ab81de41d8)',
  CLOSE,
].join('\n')
const EXPECTED_B = (path: string): string => [
  `The file ${path} has been updated successfully: 1 occurrence replaced; changed line 1201 (the file has 1996 lines).`,
  'Lines 1198-1204 as read back right after the write; they count as read:',
  '1198\tdef compute_200(x):',
  '1199\t    """Return the value of step 200."""',
  '1200\t    y = x * 200 + 302',
  '1201\tLEGACY_THRESHOLD = 8192  # the one constant the drive must change',
  '1202\t    return math.floor(y)',
  '1203\t',
  '1204\t',
  '(anchor: ra:a49e8dd511cd:L1198+7)',
  CLOSE,
].join('\n')

section('R1-R2. (j) after a full Read: the result names the change and shows the lines as a Read would')
_resetSeenLinesForTesting()
const jPath = join(fixtures, 'j_net.py')
writeFileSync(jPath, J)
const jCtx = makeContext()
await read({ file_path: jPath }, jCtx)
const r1 = await edit({ file_path: jPath, old_string: '    if wait:\n        retries = 3', new_string: '    if wait:\n        retries = 5' }, jCtx)
check('R1 the text is the specification\'s j example byte for byte (RED on .28: "updated successfully" and the no-reread note)', r1.ok && r1.text === EXPECTED_J(jPath), textOf(r1))
check('R1b the file landed as the edit said', readFileSync(jPath, 'utf8') === J.replace('        retries = 3', '        retries = 5'))
{
  const readBack = await read({ file_path: jPath, offset: 8, limit: 7 }, makeContext())
  const readRows = readBack.ok ? rowsOf(readBack.text) : []
  const editRows = r1.ok ? rowsOf(r1.text) : []
  check('R2 the rows equal, byte for byte, the rows Read(offset: 8, limit: 7) returns (RED on .28: no rows)', editRows.length === 7 && editRows.join('\n') === readRows.join('\n'), `edit: ${JSON.stringify(editRows)} read: ${JSON.stringify(readRows)}`)
  check('R2b the anchor line equals the one that Read prints for the same window', readBack.ok && r1.ok && readBack.text.includes('(anchor: ra:ed9338b863cf:L8+7)') && r1.text.includes('(anchor: ra:ed9338b863cf:L8+7)'), textOf(readBack))
}

section('R3. (a) replace_all: the count, every changed line and the whole file')
_resetSeenLinesForTesting()
mkdirSync(join(fixtures, 'a_three'))
const aPath = join(fixtures, 'a_three', 'config.py')
writeFileSync(aPath, CONFIG)
const aCtx = makeContext()
await read({ file_path: aPath }, aCtx)
const r3 = await edit({ file_path: aPath, old_string: 'TIMEOUT', new_string: 'REQUEST_TIMEOUT', replace_all: true }, aCtx)
check('R3 the text is the specification\'s a example byte for byte (RED on .28: no count and no lines)', r3.ok && r3.text === EXPECTED_A(aPath), textOf(r3))

section('R4. (f) append on a file never read: the added line, the line count and the final newline')
_resetSeenLinesForTesting()
const fPath = join(fixtures, 'f_unread.txt')
writeFileSync(fPath, F)
const r4 = await edit({ file_path: fPath, append: 'delta' }, makeContext())
check('R4 the text is the specification\'s f example byte for byte (RED on .28: the 231-byte sentence)', r4.ok && r4.text === EXPECTED_F(fPath), textOf(r4))
check('R4b append leaves exactly one final newline', readFileSync(fPath, 'utf8') === 'alpha\nbeta\ngamma\ndelta\n', JSON.stringify(readFileSync(fPath, 'utf8')))

section('R5. (b) one line in a 1,996-line file after a windowed Read')
_resetSeenLinesForTesting()
const bPath = join(fixtures, 'b_big.py')
const bText = bBig()
check('R5a the generated b_big.py is the bench fixture\'s bytes (md5 7a6dacb3cca9ac45abbf8e8557a159fc)', createHash('md5').update(bText).digest('hex') === '7a6dacb3cca9ac45abbf8e8557a159fc')
writeFileSync(bPath, bText)
const bCtx = makeContext()
await read({ file_path: bPath, offset: 1195, limit: 12 }, bCtx)
const r5 = await edit({ file_path: bPath, old_string: 'LEGACY_THRESHOLD = 4096', new_string: 'LEGACY_THRESHOLD = 8192' }, bCtx)
check('R5 the text is the specification\'s b example byte for byte', r5.ok && r5.text === EXPECTED_B(bPath), textOf(r5))

section('R6. the anchor the result prints carries the next edit with no Read between')
{
  const printed = /\(anchor: (ra:[0-9a-f]{12}:L\d+\+\d+)\)/.exec(textOf(r1))?.[1]
  const r6 = printed === undefined
    ? ({ ok: false, message: 'R1 printed no anchor to carry' } as Verdict)
    : await edit({ file_path: jPath, expected_anchor: printed, hunks: [{ lines: '12', replace: '        return open_socket(host, retries + 1)' }] }, jCtx)
  check('R6 an anchored hunks edit on the printed anchor lands (RED on .28: no anchor is printed after an edit)', printed === 'ra:ed9338b863cf:L8+7' && r6.ok && readFileSync(jPath, 'utf8').includes('        return open_socket(host, retries + 1)\n'), textOf(r6))
  check('R6b its result names the hunk and the line', r6.ok && r6.text.startsWith(`The file ${jPath} has been updated successfully: 1 hunk applied; changed line 12 (the file has 17 lines).`), textOf(r6))
}

section('R7. the bound: twenty named ranges, sixty rows, every changed line shown or named')
_resetSeenLinesForTesting()
{
  const path = join(fixtures, 'bound.txt')
  const lines = Array.from({ length: 400 }, (_, i) => ((i % 10) === 0 ? 'x = 1' : `y = ${i + 1}`))
  writeFileSync(path, lines.join('\n') + '\n')
  const ctx = makeContext()
  await read({ file_path: path }, ctx)
  const r7 = await edit({ file_path: path, old_string: 'x = 1', new_string: 'x = 2', replace_all: true }, ctx)
  const text = textOf(r7)
  const head = text.split('\n')[0] ?? ''
  const named = head.match(/changed lines ([^(]*?), and (\d+) more/)
  check('R7 WHERE names exactly 20 ranges, then ", and 20 more" (RED on .28: neither count nor lines)', r7.ok && head.includes(': all 40 occurrences replaced; changed lines ') && named !== null && named[1]!.split(', ').length === 20 && named[2] === '20', head)
  const rows = rowsOf(text)
  const body = text.split('\n').slice(1, -1).join('\n')
  check('R7b BODY has at most 60 rows and at most 6,000 rendered characters', rows.length <= 60 && rows.length > 0 && body.length <= 6000, `${rows.length} rows, ${body.length} chars`)
  const shownNumbers = new Set(rows.map(row => Number(row.split('\t')[0])))
  const notShown = /Not shown: changed lines ([^—]*) — Read\(offset: (\d+), limit: (\d+)\) shows the first of them\./.exec(text)
  const changed = Array.from({ length: 40 }, (_, k) => 1 + 10 * k)
  const named20 = notShown === null ? [] : notShown[1]!.replace(/, and \d+ more$/, '').split(', ').map(Number)
  const firstUnshown = changed.find(line => !shownNumbers.has(line))
  const allAccounted = changed.every(line => shownNumbers.has(line) || named20.includes(line) || (notShown !== null && /and \d+ more/.test(notShown[1]!) && line > named20[named20.length - 1]!))
  check('R7c every changed line is in a shown window or in the "Not shown" list', notShown !== null && allAccounted, notShown === null ? text.slice(-300) : notShown[0])
  check('R7d the Read(offset, limit) covers the first unshown change with three lines either side', notShown !== null && firstUnshown !== undefined && Number(notShown[2]) === firstUnshown - 3 && Number(notShown[3]) === 7, notShown?.[0] ?? '')
  check('R7e the shown windows are spelled in the intro and each carries its anchor', text.includes('Lines 1-4, 8-14,') && (text.match(/\(anchor: ra:[0-9a-f]{12}:L\d+\+\d+\)/g) ?? []).length >= 2, text.split('\n')[1] ?? '')
}

section('R8. a removal names the line that now follows')
{
  const r8 = await edit({ file_path: jPath, old_string: '    retries = 3\n', new_string: '' }, jCtx)
  const head = textOf(r8).split('\n')[0] ?? ''
  check('R8 HEAD ends "1 occurrence removed; removed 1 line before line 5 (the file has 16 lines)."', r8.ok && head.endsWith('1 occurrence removed; removed 1 line before line 5 (the file has 16 lines).'), head)
}

section('R9. an edit the user modified before accepting: USERMOD, the user\'s rows, and CLOSE')
_resetSeenLinesForTesting()
{
  const path = join(fixtures, 'user-modified.txt')
  const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  writeFileSync(path, body)
  const ctx = Object.assign(makeContext(), { userModifiedInput: true })
  await read({ file_path: path }, ctx)
  const r9 = await edit({ file_path: path, old_string: 'line 6', new_string: 'line six' }, ctx)
  check('R9 the text holds USERMOD, the rows of the user\'s version and CLOSE (RED on .28: nothing shown and no closing)', r9.ok && r9.text.startsWith(`The file ${path} has been updated successfully (the user modified the change before accepting it): 1 occurrence replaced; changed line 6 (the file has 12 lines).`) && r9.text.includes('\n6\tline six\n') && r9.text.endsWith(`\n${CLOSE}`), textOf(r9))
}

section('R10. the data: editedLines beside every .28 key with its .28 value')
_resetSeenLinesForTesting()
{
  const path = join(fixtures, 'j_data.py')
  writeFileSync(path, J)
  const ctx = makeContext()
  await read({ file_path: path }, ctx)
  const r10 = await edit({ file_path: path, old_string: '    if wait:\n        retries = 3', new_string: '    if wait:\n        retries = 5' }, ctx)
  const data = r10.ok ? r10.data : {}
  const edited = data.editedLines as Record<string, unknown> | undefined
  const expectedEdited = {
    what: '1 occurrence replaced',
    where: 'changed line 11',
    occurrences: 1,
    changes: [{ kind: 'changed', start: 11, end: 11 }],
    lineCount: 17,
    endsWithNewline: true,
    shown: [{ start: 8, end: 14, anchor: 'ra:ed9338b863cf:L8+7' }],
    notShown: [],
    readBack: 'same',
  }
  const { body, ...rest } = edited ?? {}
  check('R10 editedLines carries what, where, occurrences, changes, lineCount, endsWithNewline, shown, notShown and readBack (RED on .28: no editedLines)', edited !== undefined && JSON.stringify(rest) === JSON.stringify(expectedEdited), JSON.stringify(rest))
  check('R10b editedLines.body is BODY exactly as sent', typeof body === 'string' && r10.ok && r10.text === `${r10.text.split('\n')[0]}\n${body}\n${CLOSE}`, String(body))
  const expectedPatch = [{ oldStart: 8, oldLines: 7, newStart: 8, newLines: 7, lines: [' ', ' def reconnect(host, wait):', '     if wait:', '-        retries = 3', '+        retries = 5', '         return open_socket(host, retries)', '     return None', ' '] }]
  check('R10c filePath, oldString, newString, originalFile, structuredPatch, userModified and replaceAll are what .28 returns for the same call',
    data.filePath === path && data.oldString === '    if wait:\n        retries = 3' && data.newString === '    if wait:\n        retries = 5' && data.originalFile === J && JSON.stringify(data.structuredPatch) === JSON.stringify(expectedPatch) && data.userModified === false && data.replaceAll === false,
    JSON.stringify({ filePath: data.filePath, oldString: data.oldString, newString: data.newString, same: data.originalFile === J, patch: data.structuredPatch, userModified: data.userModified, replaceAll: data.replaceAll }))
  check('R10d no other key moved: the data has exactly the .28 keys plus editedLines', JSON.stringify(Object.keys(data).sort()) === JSON.stringify(['editedLines', 'filePath', 'newString', 'oldString', 'originalFile', 'replaceAll', 'structuredPatch', 'userModified']), JSON.stringify(Object.keys(data).sort()))
}

section('R11. the builder over a window reader: same, differs, failed; a CRLF file reads back the same')
{
  const written = 'one\ntwo\nthree\nfour\nfive\n'
  const patch = [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' one', '-TWO', '+two', ' three', ' four', ' five'] }]
  const feed = (rows: string[] | Error) => async (): Promise<string[]> => {
    if (rows instanceof Error) throw rows
    return rows
  }
  const map = (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam
  const base = { filePath: '/x/five.txt', oldString: 'TWO', newString: 'two', originalFile: written.replace('two', 'TWO'), structuredPatch: patch, userModified: false, replaceAll: false }
  if (editResult === null) {
    check('R11 the builder module exists (RED on .28: no src/tools/FileEditTool/editResult.ts)', false)
  } else {
    const same = await editResult.buildEditedLines({ written, patch, what: '1 occurrence replaced', occurrences: 1, path: '/x/five.txt', readWindow: feed(['one', 'two', 'three', 'four', 'five', '']) })
    const sameText = String(map({ ...base, editedLines: same.editedLines }, 'toolu_r11').content)
    check('R11a the same lines read back give READBACK same, the whole-file intro and CLOSE', same.editedLines.readBack === 'same' && sameText.includes('\nThe whole file as read back right after the write; it counts as read:\n') && sameText.endsWith(`\n${CLOSE}`) && sameText.includes('(anchor: fa:'), sameText)
    const differs = await editResult.buildEditedLines({ written, patch, what: '1 occurrence replaced', occurrences: 1, path: '/x/five.txt', readWindow: feed(['one', 'two', 'THREE', 'four', 'five', '']) })
    const differsText = String(map({ ...base, editedLines: differs.editedLines }, 'toolu_r11').content)
    check('R11b a changed line gives READBACK differs, the "differ from what this edit wrote" intro, the rows that stand, and no CLOSE', differs.editedLines.readBack === 'differs' && differsText.includes('\nLines 1-5 as read back right after the write differ from what this edit wrote — the file changed again at once; these are what stands and count as read:\n') && differsText.includes('\n3\tTHREE\n') && !differsText.includes(CLOSE), differsText)
    const failed = await editResult.buildEditedLines({ written, patch, what: '1 occurrence replaced', occurrences: 1, path: '/x/five.txt', readWindow: feed(new Error('EACCES: permission denied')) })
    const failedText = String(map({ ...base, editedLines: failed.editedLines }, 'toolu_r11').content)
    check('R11c a read error gives READBACK failed, the "reading it back failed" BODY, and no CLOSE', failed.editedLines.readBack === 'failed' && failedText.endsWith('\nThe edit was written, but reading it back failed (EACCES: permission denied); Read the lines to see what stands.') && !failedText.includes(CLOSE), failedText)
  }
  _resetSeenLinesForTesting()
  const crlfPath = join(fixtures, 'crlf.txt')
  writeFileSync(crlfPath, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n')
  const crlfCtx = makeContext()
  await read({ file_path: crlfPath }, crlfCtx)
  const crlf = await edit({ file_path: crlfPath, old_string: 'three', new_string: 'THREE' }, crlfCtx)
  const crlfEdited = crlf.ok ? (crlf.data.editedLines as { readBack?: string } | undefined) : undefined
  check('R11d a CRLF file written back with CRLF reads back the same, with rows without \\r', crlf.ok && crlfEdited?.readBack === 'same' && !crlf.text.includes('\r') && crlf.text.includes('\n3\tTHREE\n') && readFileSync(crlfPath, 'utf8') === 'one\r\ntwo\r\nTHREE\r\nfour\r\nfive\r\n', textOf(crlf))
}

section('R12. a no-change edit keeps .28\'s words, with no BODY and no CLOSE')
_resetSeenLinesForTesting()
{
  const path = join(fixtures, 'same.txt')
  const body = 'alpha\nbeta\ngamma\n'
  writeFileSync(path, body)
  const ctx = makeContext()
  await read({ file_path: path }, ctx)
  const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
  const unchanged = await edit({ file_path: path, expected_anchor: mintFileAnchor(body), hunks: [{ lines: '2', replace: 'beta' }] }, ctx)
  check('R12 the no-change text is .28\'s: "No changes made to <path>: the computed result is byte-identical…", no rows, no CLOSE', unchanged.ok && unchanged.text.startsWith(`No changes made to ${path}: the computed result is byte-identical to the current file content, so nothing was written. `) && rowsOf(unchanged.text).length === 0 && !unchanged.text.includes(CLOSE), textOf(unchanged))
  check('R12b the no-change data carries no editedLines', unchanged.ok && !('editedLines' in unchanged.data), unchanged.ok ? JSON.stringify(Object.keys(unchanged.data)) : '')
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
