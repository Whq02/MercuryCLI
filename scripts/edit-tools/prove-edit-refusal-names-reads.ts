#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-refusal-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY

const { fileGeneration, recordSeenLines, _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FILE_UNEXPECTEDLY_MODIFIED_ERROR } = await import('../../src/tools/FileEditTool/constants.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — edit refusal proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-refusal-fixture-'))
type Ctx = { readFileState: Map<string, unknown> }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
function primeRead(ctx: Ctx, path: string, window?: { offset: number; limit: number }, extra: Record<string, unknown> = {}): void {
  const full = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  const content = window ? full.split('\n').slice(window.offset - 1, window.offset - 1 + window.limit).join('\n') : full
  ctx.readFileState.set(path, {
    content,
    timestamp: Date.now() + 60_000,
    offset: window ? window.offset : undefined,
    limit: window ? window.limit : undefined,
    ...extra,
  })
}
async function validate(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true } | { ok: false; message: string }> {
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  return verdict.result === false ? { ok: false, message: String(verdict.message) } : { ok: true }
}
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true } | { ok: false; message: string }> {
  const verdict = await validate(input, ctx)
  if (!verdict.ok) return verdict
  try {
    await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
async function editResult(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const verdict = await validate(input, ctx)
  if (!verdict.ok) return verdict
  try {
    const out = await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } })
    const block = (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_fixture')
    return { ok: true, text: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const textOf = (v: { ok: boolean; text?: string; message?: string }): string => (v.ok ? v.text ?? '' : v.message ?? '')
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n'
const LAW = 'Read the file before editing it'
const owner = processMainOwner()
const messageOf = (v: { ok: boolean; message?: string }): string => (v.ok ? '(edited)' : v.message ?? '')

section('R. the refusal names the lines read and the lines the edit touches; a file read as it stands lands in one call')
{
  const file = join(fixtures, 'thirty.ts')
  writeFileSync(file, lines(30))
  const none = await validate({ file_path: file, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, makeContext())
  check('R1 with no read at all the law refuses, leading with what to do', !none.ok && none.message.startsWith('The lines the edit touches are below and count as read: edit again without a Read.') && none.message.includes('expected_anchor'), messageOf(none))
  check('R1a …saying no lines were read', !none.ok && none.message.includes(`No lines of ${file} were read this session`), messageOf(none))
  check('R1b …naming the lines the edit touches and carrying them with a margin', !none.ok && none.message.includes('the edit touches lines 12-13 — lines 9-16 are below and count as read: edit again without a Read.'), messageOf(none))
  _resetSeenLinesForTesting()

  const ctx = makeContext()
  primeRead(ctx, file, { offset: 1, limit: 2 })
  recordSeenLines(owner, file, fileGeneration(file)!, 20, 3)
  const partial = await editResult({ file_path: file, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, ctx)
  check('R2 a windowed read beside a displayed range: the edit of lines between them lands in one call', partial.ok && readFileSync(file, 'utf8').includes('\nx\n'), textOf(partial))
  check('R2a …and the result names the lines that did not count as read, then the edited lines as they now stand', partial.ok && partial.text.includes('has been updated successfully') && partial.text.includes('Lines 12-13 did not count as read before this edit; lines 9-15 as they stand now are below, numbered with their anchor, and count as read:') && /\n12\tx\n13\tconst v14 = 14\n/.test(partial.text), textOf(partial))

  _resetSeenLinesForTesting()
  const many = makeContext()
  for (const [start, count] of [[1, 2], [5, 1], [8, 1], [10, 1], [20, 3], [26, 2], [29, 1]] as const) recordSeenLines(owner, file, fileGeneration(file)!, start, count)
  const manyRefused = await validate({ file_path: file, old_string: 'const v18 = 18', new_string: 'y', expected_anchor: mintFileAnchor('other bytes\n') }, many)
  check('R3 more than a handful of ranges: five are named and the rest counted', !manyRefused.ok && manyRefused.message.includes('read this session: 1-2, 5, 8, 10, 20-22 (and 2 more ranges);'), messageOf(manyRefused))

  const single = await editResult({ file_path: file, old_string: 'const v4 = 4', new_string: 'const v4 = 44' }, many)
  check('R4 a one-line edit names its line in the singular', single.ok && single.text.includes('Line 4 did not count as read before this edit; lines 1-7 as they stand now are below, numbered with their anchor, and count as read:') && /\n4\tconst v4 = 44\n/.test(single.text), textOf(single))

  const ctxWindow = makeContext()
  primeRead(ctxWindow, file, { offset: 1, limit: 2 })
  const missing = await validate({ file_path: file, old_string: 'const nowhere = 0', new_string: 'x' }, ctxWindow)
  check('R5 an old_string absent from the file says so instead of guessing lines', !missing.ok && missing.message.includes(LAW) && missing.message.includes('the old_string was not found in the current content, so the lines the edit touches are unknown'), messageOf(missing))

  const heading = await validate({ file_path: file, section: '## Nope', new_string: '## Nope\n' }, ctxWindow)
  check('R6 a section edit whose heading is absent says so in section words', !heading.ok && heading.message.includes('the section heading was not found in the current content'), messageOf(heading))

  _resetSeenLinesForTesting()
  const hunks = await validate({ file_path: file, expected_anchor: mintFileAnchor('other bytes\n'), hunks: [{ lines: '3-4', replace: 'x' }, { lines: '9', replace: 'y' }] }, makeContext())
  check('R7 a hunks edit with a stale anchor names the hunk lines it addresses and leads with the anchor', !hunks.ok && hunks.message.startsWith('expected_anchor does not match the file as it stands; the lines the edit touches are below with their current anchor and count as read: edit again with a carried anchor, without a Read.') && hunks.message.includes(`No lines of ${file} were read this session; the edit touches lines 3-4, 9 — lines 1-12 are below and count as read: edit again with a carried anchor, without a Read.`), messageOf(hunks))

  _resetSeenLinesForTesting()
  const part = join(fixtures, 'part.ts')
  writeFileSync(part, lines(30))
  const ctxCover = makeContext()
  primeRead(ctxCover, part, { offset: 12, limit: 1 })
  const half = await editResult({ file_path: part, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, ctxCover)
  check('R8 a read covering part of the touched lines: the edit lands in one call and the result carries the rest with its margin', half.ok && half.text.includes('Line 13 did not count as read before this edit; lines 9-15 as they stand now are below, numbered with their anchor, and count as read:'), textOf(half))

  const attachedFile = join(fixtures, 'attached.ts')
  writeFileSync(attachedFile, lines(12))
  const ctxAttachment = makeContext()
  primeRead(ctxAttachment, attachedFile, undefined, { isPartialView: true })
  const attached = await validate({ file_path: attachedFile, old_string: 'const v12 = 12', new_string: 'x' }, ctxAttachment)
  check('R9 an automatic attachment is named as not a read', !attached.ok && attached.message.includes('(an automatic attachment showed part of it, which is not a read)'), messageOf(attached))
}

section('E. a read of an earlier version of the file is named as such')
{
  const file = join(fixtures, 'drift.ts')
  writeFileSync(file, lines(10))
  recordSeenLines(owner, file, fileGeneration(file)!, 1, 10)
  writeFileSync(file, lines(10).replace('const v5 = 5', 'const v5 = 500'))
  const past = new Date(Date.now() - 120_000)
  utimesSync(file, past, past)
  const drifted = await validate({ file_path: file, old_string: 'const v5 = 500', new_string: 'x' }, makeContext())
  check('E1 the ledger of an older generation is reported as a read of the file before it last changed', !drifted.ok && drifted.message.includes(`The lines of ${file} read this session were of the file before it last changed; the edit touches line 5 — lines 2-8 are below and count as read: edit again without a Read.`), messageOf(drifted))
  const ctx = makeContext()
  primeRead(ctx, file)
  writeFileSync(file, lines(10).replace('const v5 = 5', 'const v5 = 5000'))
  const later = new Date(Date.now() + 120_000)
  utimesSync(file, later, later)
  const stale = await validate({ file_path: file, old_string: 'const v5 = 5000', new_string: 'x' }, ctx)
  check('E2 a full read whose bytes no longer match still refuses as an unexpected modification, not as an unread file', !stale.ok && stale.message === FILE_UNEXPECTEDLY_MODIFIED_ERROR, messageOf(stale))
}

section('L. the law itself is unchanged')
{
  const file = join(fixtures, 'law.ts')
  writeFileSync(file, lines(6))
  const ctxWindow = makeContext()
  primeRead(ctxWindow, file, { offset: 2, limit: 2 })
  const inWindow = await edit({ file_path: file, old_string: 'const v3 = 3', new_string: 'const v3 = 33' }, ctxWindow)
  check('L1 a windowed read that showed the line still edits it', inWindow.ok && readFileSync(file, 'utf8').includes('const v3 = 33'), messageOf(inWindow))
  recordSeenLines(owner, file, fileGeneration(file)!, 5, 1)
  const shown = await edit({ file_path: file, old_string: 'const v5 = 5', new_string: 'const v5 = 55' }, makeContext())
  check('L2 a line the ledger shows for the current generation still edits', shown.ok && readFileSync(file, 'utf8').includes('const v5 = 55'), messageOf(shown))
  const ctxFull = makeContext()
  primeRead(ctxFull, file)
  const full = await edit({ file_path: file, old_string: 'const v1 = 1', new_string: 'const v1 = 11' }, ctxFull)
  check('L3 a full read still edits anywhere', full.ok && readFileSync(file, 'utf8').includes('const v1 = 11'), messageOf(full))
  const anchored = await edit({ file_path: file, old_string: 'const v2 = 2', new_string: 'const v2 = 22', expected_anchor: mintFileAnchor(readFileSync(file, 'utf8')) }, makeContext())
  check('L4 a matching full anchor still edits without a read', anchored.ok && readFileSync(file, 'utf8').includes('const v2 = 22'), messageOf(anchored))
  const before = readFileSync(file, 'utf8')
  const refused = await edit({ file_path: file, old_string: 'const v6 = 6', new_string: 'const v6 = 66' }, makeContext())
  check('L5 a line of a file that changed after the lines you read still refuses and writes nothing, leading with the change', !refused.ok && refused.message.startsWith(`The file ${file} changed after the lines you read; the lines the edit touches, as they stand now, are below and count as read: check them, then edit again without a Read.`) && readFileSync(file, 'utf8') === before, messageOf(refused))
  const carried = await edit({ file_path: file, old_string: 'const v6 = 6', new_string: 'const v6 = 66' }, makeContext())
  check('L5a …and the same edit lands on the lines the refusal carried', carried.ok && readFileSync(file, 'utf8').includes('const v6 = 66'), messageOf(carried))
  const never = join(fixtures, 'never.ts')
  writeFileSync(never, lines(6))
  const neverRead = await edit({ file_path: never, old_string: 'const v6 = 6', new_string: 'const v6 = 66' }, makeContext())
  check('L5b a file never read still refuses and writes nothing, leading with what to do', !neverRead.ok && neverRead.message.startsWith('The lines the edit touches are below and count as read: edit again without a Read.') && readFileSync(never, 'utf8') === lines(6), messageOf(neverRead))
  const neverAgain = await edit({ file_path: never, old_string: 'const v6 = 6', new_string: 'const v6 = 66' }, makeContext())
  check('L5c …and the same edit lands on the lines the refusal carried', neverAgain.ok && readFileSync(never, 'utf8').includes('const v6 = 66'), messageOf(neverAgain))
  const appended = await edit({ file_path: file, append: 'const v7 = 7\n' }, makeContext())
  check('L6 an append still needs no read', appended.ok && readFileSync(file, 'utf8').endsWith('const v7 = 7\n'), messageOf(appended))
}

section('the diagnostic reads the same current knowledge as the gate')
{
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { mintRangeAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'generation.ts')
  const original = lines(20)
  writeFileSync(file, original)
  const ctx = makeContext()
  const parent = { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } }
  await (FileReadTool as { call: Function }).call({ file_path: file, offset: 1, limit: 5, line_anchors: true }, ctx, null, parent)
  const changed = original.replace('const v1 = 1', 'const v1 = 1000')
  writeFileSync(file, changed)
  const later = new Date(Date.now() + 120_000)
  utimesSync(file, later, later)
  recordSeenLines(owner, file, fileGeneration(file)!, 6, 5)
  const refused = await validate({ file_path: file, expected_anchor: mintRangeAnchor(original.split('\n').slice(0, 5).join('\n'), 1, 5), hunks: [{ lines: '1-10', replace: 'replacement' }] }, ctx)
  const words = messageOf(refused)
  check('an old Read window is not combined with the current ledger to claim every refused line was read', !refused.ok && !words.includes('read this session: 1-10;') && words.includes('read this session: 6-10'), words)
  check('the refusal names the generation and anchor checks and gives the next read or carried window', !refused.ok && words.includes('File generation check failed:') && words.includes('Anchor check failed:') && /Read\(offset:|count as read/.test(words), words)
  check('the refused anchored edit leaves the current bytes untouched', readFileSync(file, 'utf8') === changed)
  const exceptional = makeContext()
  Object.defineProperty(exceptional, 'owner', { get() { throw new Error('planted ownership lookup failure') } })
  let fault: { ok: true } | { ok: false; message: string }
  try {
    fault = await validate({ file_path: file, old_string: 'const v12 = 12', new_string: 'replacement' }, exceptional)
  } catch (error) {
    fault = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  check('an ownership lookup exception keeps its own cause, never an unread-file explanation', !fault.ok && fault.message.includes('planted ownership lookup failure') && !fault.message.includes('No lines of'), messageOf(fault))
  const bomFile = join(fixtures, 'bom.ts')
  writeFileSync(bomFile, '\uFEFF' + original)
  const bomContext = makeContext()
  await (FileReadTool as { call: Function }).call({ file_path: bomFile, offset: 1, limit: 5 }, bomContext, null, parent)
  _resetSeenLinesForTesting()
  const bomEdit = await editResult({ file_path: bomFile, old_string: 'const v12 = 12', new_string: 'replacement' }, bomContext)
  check('an unchanged BOM is not misreported as a generation change: the edit beside the window lands in one call', bomEdit.ok && bomEdit.text.includes('Line 12 did not count as read before this edit') && !bomEdit.text.includes('File generation check failed:'), textOf(bomEdit))
  const separateFile = join(fixtures, 'separate.ts')
  writeFileSync(separateFile, original)
  const separateContext = makeContext()
  await (FileReadTool as { call: Function }).call({ file_path: separateFile, offset: 1, limit: 5 }, separateContext, null, parent)
  writeFileSync(separateFile, original.replace('const v18 = 18', 'const v18 = 1800'))
  utimesSync(separateFile, later, later)
  recordSeenLines(owner, separateFile, fileGeneration(separateFile)!, 6, 5)
  const separateInput = { file_path: separateFile, old_string: original.split('\n').slice(0, 10).join('\n'), new_string: 'replacement' }
  const separate = await editResult(separateInput, separateContext)
  check("separate sources are never combined into one read: the ledger's missing lines are carried and the edit lands with them in its result", separate.ok && separate.text.includes('Lines 1-5 did not count as read before this edit') && !separate.text.includes('read this session: 1-10;') && readFileSync(separateFile, 'utf8').startsWith('replacement'), textOf(separate))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
