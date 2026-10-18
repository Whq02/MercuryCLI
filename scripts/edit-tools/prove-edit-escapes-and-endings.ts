#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-escapes-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { locateActualString } = await import('../../src/tools/FileEditTool/utils.ts')
const { preserveUntouchedLineEndings } = await import('../../src/utils/file.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 500 ? `${detail.slice(0, 500)}…` : detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const fixtures = mkdtempSync(join(tmpdir(), 'edit-escapes-fixture-'))
type Entry = { content: string; timestamp: number; offset?: number; limit?: number }
type Ctx = { readFileState: Map<string, Entry> }
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
function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, { content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), timestamp: Date.now() + 60_000 })
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000007', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string } | { ok: false; message: string }
async function edit(input: Record<string, unknown>): Promise<Verdict> {
  const ctx = makeContext()
  primeRead(ctx, input.file_path as string)
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  try {
    const out = await (FileEditTool as { call: Function }).call(input, ctx, null, PARENT)
    const block = (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_fixture')
    return { ok: true, text: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const messageOf = (v: Verdict): string => (v.ok ? `(landed) ${v.text.slice(0, 240)}` : v.message)
const hex = (path: string): string => readFileSync(path).toString('hex')
const bytes = (path: string): string => readFileSync(path, 'latin1')
let n = 0
function fixture(name: string, content: string | Buffer): string {
  const path = join(fixtures, `${++n}-${name}`)
  writeFileSync(path, content)
  return path
}

section('A. a double-escaped old_string matches only when the exact unescaped bytes exist')
{
  const file = fixture('escapes.ts', 'const greeting = "hi"\nconst sum = a + b\n\tindented()\nconst tail = 1\n')
  const landed = await edit({ file_path: file, old_string: 'const sum = a + b\\n\\tindented()', new_string: 'const sum = a + b\\n\\tindented(1)' })
  check('A1 the \\n and \\t sequences are read as the newline and tab the file carries, and the edit lands', landed.ok && bytes(file) === 'const greeting = "hi"\nconst sum = a + b\n\tindented(1)\nconst tail = 1\n', messageOf(landed))
  check('A2 the result says which road matched and that new_string was read the same way', landed.ok && landed.text.includes('with the \\n, \\t and \\r sequences of old_string read as the characters they spell') && landed.text.includes('new_string was read the same way'), messageOf(landed))
  const literal = fixture('literal.js', 'const text = "a\\nb"\nconst other = 2\n')
  const kept = await edit({ file_path: literal, old_string: 'const text = "a\\nb"', new_string: 'const text = "a\\nc"' })
  check('A3 a file that carries the two-character sequence itself is matched exactly, never unescaped', kept.ok && bytes(literal) === 'const text = "a\\nc"\nconst other = 2\n' && !kept.text.includes('read as the characters'), messageOf(kept))
}

section('B. refusals: the unescaped bytes absent or not unique, and no drift of any other kind')
{
  const file = fixture('absent.ts', 'alpha()\nbeta()\ngamma()\n')
  const absent = await edit({ file_path: file, old_string: 'alpha()\\nomega()', new_string: 'x' })
  check('B1 unescaped bytes that are not in the file are refused as not found', !absent.ok && /not found/i.test(absent.message), messageOf(absent))
  check('B1 nothing was written', bytes(file) === 'alpha()\nbeta()\ngamma()\n')
  const twice = fixture('twice.ts', 'one()\n\ttwo()\nmid\none()\n\ttwo()\n')
  const ambiguous = await edit({ file_path: twice, old_string: 'one()\\n\\ttwo()', new_string: 'x' })
  check('B2 two occurrences of the unescaped bytes are refused as not unique, naming the road', !ambiguous.ok && ambiguous.message.includes('found after reading the \\n, \\t and \\r sequences as the characters they spell') && /lines/.test(ambiguous.message), messageOf(ambiguous))
  check('B2 nothing was written', bytes(twice) === 'one()\n\ttwo()\nmid\none()\n\ttwo()\n')
  const spaced = fixture('spaced.ts', 'first()\n  second()\n')
  const drift = await edit({ file_path: spaced, old_string: 'first()\\n\\tsecond()', new_string: 'x' })
  check('B3 a tab where the file has spaces is not matched: the unescaped bytes must exist as such (no whitespace normalisation)', !drift.ok && bytes(spaced) === 'first()\n  second()\n', messageOf(drift))
  const near = fixture('near.ts', 'load()\nparse()\nemit()\n')
  const similar = await edit({ file_path: near, old_string: 'load()\\nparse(x)\\nemit()', new_string: 'x' })
  check('B4 a near miss inside the unescaped text is refused (no similarity road)', !similar.ok && bytes(near) === 'load()\nparse()\nemit()\n', messageOf(similar))
  const trimmed = fixture('trimmed.ts', 'open()\n  close()  \n')
  const boundary = await edit({ file_path: trimmed, old_string: 'open()\\n  close()', new_string: 'open()\\n  close(1)' })
  check('B5 the exact bytes are found when they exist, the trailing spaces untouched', boundary.ok && bytes(trimmed) === 'open()\n  close(1)  \n', messageOf(boundary))
  const found = locateActualString('a\nb', 'a\\nb')
  check('B6 the road is named escapes and reports the lines it matched', found.kind === 'found' && found.road === 'escapes' && found.startLine === 1 && found.endLine === 2, JSON.stringify(found))
  const control = locateActualString('plain text', 'plain text')
  check('B7 an exact match is still the exact road (the control)', control.kind === 'found' && control.road === 'exact' && control.feedback === null)
}

section('C. a mixed-ending file keeps each untouched line\'s ending, byte for byte')
{
  const mixed = fixture('mixed.txt', 'one\r\ntwo\nthree\r\nfour\nfive\r\n')
  const before = hex(mixed)
  const landed = await edit({ file_path: mixed, old_string: 'three', new_string: 'THREE' })
  check('C1 the edit lands on the LF view', landed.ok, messageOf(landed))
  check('C2 hexdump: CRLF on lines 1, 3 and 5 and LF on 2 and 4 survive; only the word changed', hex(mixed) === '6f6e650d0a74776f0a54485245450d0a666f75720a666976650d0a', `${before} -> ${hex(mixed)}`)
  const region = 'one\r\ntwo\nthree\r\nfour\nfive\r\n'
  const widened = preserveUntouchedLineEndings(region, 'one\ntwo\nadded\nthree\nfour\nfive\n', 'LF')
  check('C3 a line added inside a region keeps the surviving lines\' own endings (the LCS alignment) and takes the majority itself', widened === 'one\r\ntwo\nadded\nthree\r\nfour\nfive\r\n', JSON.stringify(widened))
  const replaced = preserveUntouchedLineEndings('a\r\nb\nc\r\n', 'a\r\nB\nc\r\n'.replaceAll('\r\n', '\n'), 'CRLF')
  check('C4 a line replaced one for one keeps the ending of the line it replaces', replaced === 'a\r\nB\nc\r\n', JSON.stringify(replaced))
  const grown = preserveUntouchedLineEndings('x\r\ny\nz\r\n', 'x\ny1\ny2\nz\n', 'CRLF')
  check('C5 two lines replacing one take the majority, their neighbours keep their own', grown === 'x\r\ny1\r\ny2\r\nz\r\n', JSON.stringify(grown))
  const inner = preserveUntouchedLineEndings('a\r\nb\nc\r\nd\n', 'A\nb\nC1\nC2\nd\n', 'CRLF')
  check('C7 an untouched line between two changed ones keeps its LF while the one-for-one replacement keeps CRLF and the grown pair takes the majority', inner === 'A\r\nb\nC1\r\nC2\r\nd\n', JSON.stringify(inner))
  const bom = fixture('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('head\r\nbody\r\n')]))
  const bomEdit = await edit({ file_path: bom, old_string: 'body', new_string: 'BODY' })
  check('C6 a BOM and the CRLF endings are kept through the edit', bomEdit.ok && hex(bom) === 'efbbbf686561640d0a424f44590d0a', `${messageOf(bomEdit)} ${hex(bom)}`)
}

section('D. strings that differ only in carriage returns change the endings on exact bytes')
{
  const crlf = fixture('crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n')
  const toLf = await edit({ file_path: crlf, old_string: 'beta\r\n', new_string: 'beta\n' })
  check('D1 one CRLF becomes LF and the other two stay', toLf.ok && hex(crlf) === '616c7068610d0a626574610a67616d6d610d0a', `${messageOf(toLf)} ${hex(crlf)}`)
  check('D1 the result says the endings changed', toLf.ok && toLf.text.includes('line endings changed at 1 place'), messageOf(toLf))
  const all = fixture('all.txt', 'x\r\ny\r\nx\r\n')
  const every = await edit({ file_path: all, old_string: 'x\r\n', new_string: 'x\n', replace_all: true })
  check('D2 replace_all converts every occurrence of the line and leaves the other line alone', every.ok && hex(all) === '780a790d0a780a' && every.text.includes('line endings changed at 2 places'), `${messageOf(every)} ${hex(all)}`)
  const lf = fixture('lf.txt', 'a\nb\nc\n')
  const toCrlf = await edit({ file_path: lf, old_string: 'b\n', new_string: 'b\r\n' })
  check('D3 LF to CRLF on one line, the others untouched', toCrlf.ok && hex(lf) === '610a620d0a630a', `${messageOf(toCrlf)} ${hex(lf)}`)
  const missing = fixture('missing.txt', 'a\nb\n')
  const noCr = await edit({ file_path: missing, old_string: 'b\r\n', new_string: 'b\n' })
  check('D4 a CRLF the file does not carry is not an ending change: the ordinary roads answer and the bytes stay', bytes(missing) === 'a\nb\n', messageOf(noCr))
  const same = fixture('same.txt', 'a\r\nb\r\n')
  const unchanged = await edit({ file_path: same, old_string: 'b\r\n', new_string: 'b\r\n' })
  check('D5 identical strings are refused as before (the control)', !unchanged.ok && hex(same) === '610d0a620d0a', messageOf(unchanged))
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  console.log('RED: prove-edit-escapes-and-endings.ts')
  process.exit(1)
}
console.log('\nALL GREEN')
