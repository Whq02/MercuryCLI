#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-own-ledger-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.NODE_ENV

const { fileGeneration, seenLinesOf, _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FILE_UNEXPECTEDLY_MODIFIED_ERROR } = await import('../../src/tools/FileEditTool/constants.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 400 ? `${detail.slice(0, 400)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the own-edit ledger proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-own-ledger-fixture-'))
type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
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
const PARENT = { uuid: '00000000-0000-0000-0000-000000000006', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string } | { ok: false; message: string }
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> {
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
async function write(path: string, content: string, ctx: Ctx): Promise<void> {
  const verdict = await (FileWriteTool as { validateInput: Function }).validateInput({ file_path: path, content }, ctx)
  if (verdict.result === false) throw new Error(`fixture write refused: ${String(verdict.message)}`)
  await (FileWriteTool as { call: Function }).call({ file_path: path, content }, ctx, null, PARENT)
}
async function read(path: string, ctx: Ctx, lineAnchors: boolean): Promise<string> {
  const input = { file_path: path, offset: 0, limit: 2000, ...(lineAnchors ? { line_anchors: true } : {}) }
  const out = await (FileReadTool as { call: Function }).call(input, ctx, null, PARENT)
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_read')
  return typeof block.content === 'string' ? block.content : ''
}
const messageOf = (v: Verdict): string => (v.ok ? '(edited)' : v.message)
const contentOf = (p: string): string => readFileSync(p, 'utf8').replaceAll('\r\n', '\n')
const anchorOf = (text: string): string | undefined => /\(anchor: (fa:[0-9a-f]+)\)/.exec(text)?.[1]
const owner = processMainOwner()
const report = (n: number): string =>
  [
    '# The panel report',
    '',
    '## 1. Symptom reproduced',
    '',
    `(frame, record) The deployed bundle identifies itself as build ${n}. At both sizes the panels stayed open after a click outside their frames.`,
    '',
    'The original capture command was the adapted vshot driver, with the frames folder beside this report.',
    '',
    '(live) Load was 2.92 before the first capture and 2.25 when the reproduction was read. The enrolled red drive started at load 1.83.',
    '',
    '## 5. Proofs',
    '',
    'No panel frame, dim policy, close key, focus-return callback, export or product environment flag is removed or changed.',
    '',
    'This run wrote no owner-home project.',
    '',
  ].join('\n')

section('A. THE RECORD\'S ROAD — Write, Read with line anchors, three Edits, the read entry gone, a fourth Edit (RED on the base: refused as "changed after the lines you read")')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'REPORT.md')
  const ctx = makeContext()
  await write(file, report(18), ctx)
  const shown = await read(file, ctx, true)
  const anchor = anchorOf(shown)
  check('A1 the Read carries a full-file anchor and records the ledger at the file generation', anchor !== undefined && seenLinesOf(owner, file)?.generation === fileGeneration(file), `anchor=${anchor} ledger=${JSON.stringify(seenLinesOf(owner, file))}`)
  const first = await edit({ file_path: file, old_string: 'The enrolled red drive started at load 1.83.', new_string: 'The enrolled red drive started at load 1.84.', expected_anchor: anchor }, ctx)
  check('A2 the first edit (with the Read anchor) lands', first.ok && contentOf(file).includes('load 1.84.'), messageOf(first))
  const ledgerAfterFirst = seenLinesOf(owner, file)
  check('A3 after the tool\'s own edit the ledger stands at the new generation (RED on the base: it stayed at the Read\'s)', ledgerAfterFirst !== undefined && ledgerAfterFirst.generation === fileGeneration(file) && ledgerAfterFirst.ranges.some(r => r.start === 1 && r.end >= 15), JSON.stringify(ledgerAfterFirst))
  const second = await edit({ file_path: file, old_string: 'No panel frame, dim policy, close key, focus-return callback, export or product environment flag is removed or changed.', new_string: 'Panel frames, dim policy, close keys and focus-return callbacks stay unchanged. No export is removed and no product environment flag is added.' }, ctx)
  const third = await edit({ file_path: file, old_string: 'This run wrote no owner-home project.', new_string: 'No new owner-home project was observed.' }, ctx)
  check('A4 the second and third edits land on the entry the tool refreshed', second.ok && third.ok && contentOf(file).includes('No new owner-home project was observed.'), `${messageOf(second)} | ${messageOf(third)}`)
  const entry = ctx.readFileState.get(file)
  check('A5 the read entry holds the updated file as a full read, stamped at the file mtime', entry !== undefined && entry.offset === undefined && entry.limit === undefined && entry.content === contentOf(file) && entry.timestamp === Math.floor(statSync(file).mtimeMs), JSON.stringify({ offset: entry?.offset, limit: entry?.limit, timestamp: entry?.timestamp, mtime: Math.floor(statSync(file).mtimeMs) }))
  const ledgerAfterThird = seenLinesOf(owner, file)
  check('A6 the ledger followed every edit: its generation is the file\'s and it covers the whole file', ledgerAfterThird !== undefined && ledgerAfterThird.generation === fileGeneration(file) && ledgerAfterThird.ranges.length === 1 && ledgerAfterThird.ranges[0]!.start === 1 && ledgerAfterThird.ranges[0]!.end === contentOf(file).split('\n').length - 1, JSON.stringify(ledgerAfterThird))

  ctx.readFileState.delete(file)
  const fourth = await edit({ file_path: file, old_string: 'The original capture command was the adapted vshot driver, with', new_string: 'The original capture command was the adapted vshot driver `capture.ts` retained beside this report, with' }, ctx)
  check('A7 with the read entry gone the fourth edit still lands: the ledger vouches for the file the tool itself produced (RED on the base)', fourth.ok && contentOf(file).includes('`capture.ts` retained beside this report'), messageOf(fourth))
  check('A8 …and no refusal named the file as changed', fourth.ok || !fourth.message.includes('changed after the lines you read'), messageOf(fourth))
}

section('B. THE RESUME ROAD — a fresh context (an empty read cache) with the same owner edits the file it wrote and edited before (RED on the base)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'collapse-proof.ts')
  const body = Array.from({ length: 90 }, (_, i) => (i === 69 ? "check('a single running or unresolved call keeps its existing tool row', () => {" : `const line${i + 1} = ${i + 1}`)).join('\n') + '\n'
  const before = makeContext()
  await write(file, body, before)
  const shown = await read(file, before, false)
  const anchor = anchorOf(shown)
  const one = await edit({ file_path: file, old_string: 'const line10 = 10', new_string: 'const line10 = 1000', expected_anchor: anchor }, before)
  const two = await edit({ file_path: file, old_string: 'const line20 = 20', new_string: 'const line20 = 2000' }, before)
  check('B1 the first run writes, reads and edits twice', one.ok && two.ok, `${messageOf(one)} | ${messageOf(two)}`)
  const resumed = makeContext()
  const three = await edit({ file_path: file, old_string: "check('a single running or unresolved call keeps its existing tool row', () => {", new_string: "check('the first running call already has the same card identity as the settled call', () => {" }, resumed)
  check('B2 the resumed run\'s first edit on that file lands without a Read (RED on the base: "File generation check failed: earlier read coverage belongs to the file before it changed")', three.ok && contentOf(file).includes('the first running call already has the same card identity'), messageOf(three))
  const ledger = seenLinesOf(owner, file)
  check('B3 the ledger stands at the generation the resumed edit produced', ledger !== undefined && ledger.generation === fileGeneration(file), JSON.stringify(ledger))
}

section('C. THE LAW KEPT — a file another writer changed between the read and the edit still refuses, entry present or gone')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'shared.ts')
  const ctx = makeContext()
  await write(file, Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n', ctx)
  await read(file, ctx, false)
  const mine = await edit({ file_path: file, old_string: 'const v5 = 5', new_string: 'const v5 = 55' }, ctx)
  check('C1 the tool\'s own edit lands', mine.ok, messageOf(mine))
  writeFileSync(file, contentOf(file).replace('const v20 = 20', 'const v20 = 20 // another writer'))
  const later = new Date(Date.now() + 120_000)
  utimesSync(file, later, later)
  const withEntry = await edit({ file_path: file, old_string: 'const v7 = 7', new_string: 'const v7 = 77' }, ctx)
  check('C2 with the read entry present, the other writer\'s change refuses as it always did', !withEntry.ok && withEntry.message === FILE_UNEXPECTEDLY_MODIFIED_ERROR, messageOf(withEntry))
  ctx.readFileState.delete(file)
  const withoutEntry = await edit({ file_path: file, old_string: 'const v7 = 7', new_string: 'const v7 = 77' }, ctx)
  check('C3 with the read entry gone, the other writer\'s change refuses with the change named: the ledger\'s generation is not the file\'s', !withoutEntry.ok && withoutEntry.message.startsWith(`The file ${file} changed after the lines you read`) && withoutEntry.message.includes('File generation check failed: earlier read coverage belongs to the file before it changed.'), messageOf(withoutEntry))
  check('C4 …and nothing was written', !contentOf(file).includes('const v7 = 77'))
  const retried = await edit({ file_path: file, old_string: 'const v7 = 7', new_string: 'const v7 = 77' }, ctx)
  check('C5 the retry after the refusal\'s carry lands (the carried lines were shown for the current generation)', retried.ok && contentOf(file).includes('const v7 = 77'), messageOf(retried))
}

section('D. THE STAMP\'S RESOLUTION — two of the tool\'s own edits inside one second keep the ledger current (the generation keys the millisecond and the size)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'quick.ts')
  const ctx = makeContext()
  await write(file, Array.from({ length: 12 }, (_, i) => `const q${i + 1} = ${i + 1}`).join('\n') + '\n', ctx)
  await read(file, ctx, false)
  const a = await edit({ file_path: file, old_string: 'const q2 = 2', new_string: 'const q2 = 3' }, ctx)
  const b = await edit({ file_path: file, old_string: 'const q4 = 4', new_string: 'const q4 = 5' }, ctx)
  ctx.readFileState.delete(file)
  const c = await edit({ file_path: file, old_string: 'const q6 = 6', new_string: 'const q6 = 7' }, ctx)
  check('D1 three same-size edits in quick succession, the entry dropped before the last, all land', a.ok && b.ok && c.ok, `${messageOf(a)} | ${messageOf(b)} | ${messageOf(c)}`)
  const ledger = seenLinesOf(owner, file)
  check('D2 the ledger names the file\'s current generation', ledger !== undefined && ledger.generation === fileGeneration(file), JSON.stringify({ ledger, now: fileGeneration(file) }))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
