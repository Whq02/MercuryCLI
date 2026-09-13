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

const { fileGeneration, recordSeenLines } = await import('../../src/services/changeTransaction/seenLines.ts')
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
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n'
const LAW = 'Read the file before editing it'
const owner = processMainOwner()
const messageOf = (v: { ok: boolean; message?: string }): string => (v.ok ? '(edited)' : v.message ?? '')

section('R. the refusal names the lines read and the lines the edit touches')
{
  const file = join(fixtures, 'thirty.ts')
  writeFileSync(file, lines(30))
  const none = await validate({ file_path: file, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, makeContext())
  check('R1 with no read at all the law refuses in its own words', !none.ok && none.message.includes(LAW) && none.message.includes('expected_anchor'), messageOf(none))
  check('R1a …saying no lines were read', !none.ok && none.message.includes(`No lines of ${file} were read this session`), messageOf(none))
  check('R1b …naming the lines the edit touches and the Read that covers them', !none.ok && none.message.includes('the edit touches lines 12-13 — Read(offset: 12, limit: 2) covers them'), messageOf(none))

  const ctx = makeContext()
  primeRead(ctx, file, { offset: 1, limit: 2 })
  recordSeenLines(owner, file, fileGeneration(file)!, 20, 3)
  const partial = await validate({ file_path: file, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, ctx)
  check('R2 a windowed read and a displayed range are both named, coalesced and in order', !partial.ok && partial.message.includes(`Lines of ${file} read this session: 1-2, 20-22;`), messageOf(partial))
  check('R2a …with the touched lines and the Read that closes the gap', !partial.ok && partial.message.includes('the edit touches lines 12-13 — Read(offset: 12, limit: 2) covers the gap'), messageOf(partial))

  recordSeenLines(owner, file, fileGeneration(file)!, 5, 1)
  recordSeenLines(owner, file, fileGeneration(file)!, 8, 1)
  recordSeenLines(owner, file, fileGeneration(file)!, 10, 1)
  recordSeenLines(owner, file, fileGeneration(file)!, 26, 2)
  recordSeenLines(owner, file, fileGeneration(file)!, 29, 1)
  const many = await validate({ file_path: file, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, ctx)
  check('R3 more than a handful of ranges: five are named and the rest counted', !many.ok && many.message.includes('read this session: 1-2, 5, 8, 10, 20-22 (and 2 more ranges);'), messageOf(many))

  const single = await validate({ file_path: file, old_string: 'const v7 = 7', new_string: 'x' }, ctx)
  check('R4 a one-line edit names its line in the singular', !single.ok && single.message.includes('the edit touches line 7 — Read(offset: 7, limit: 1) covers the gap'), messageOf(single))

  const missing = await validate({ file_path: file, old_string: 'const nowhere = 0', new_string: 'x' }, ctx)
  check('R5 an old_string absent from the file says so instead of guessing lines', !missing.ok && missing.message.includes(LAW) && missing.message.includes('the old_string was not found in the current content, so the lines the edit touches are unknown'), messageOf(missing))

  const heading = await validate({ file_path: file, section: '## Nope', new_string: '## Nope\n' }, ctx)
  check('R6 a section edit whose heading is absent says so in section words', !heading.ok && heading.message.includes('the section heading was not found in the current content'), messageOf(heading))

  const hunks = await validate({ file_path: file, expected_anchor: mintFileAnchor('other bytes\n'), hunks: [{ lines: '3-4', replace: 'x' }, { lines: '9', replace: 'y' }] }, ctx)
  check('R7 a hunks edit names the hunk lines it addresses', !hunks.ok && hunks.message.includes(LAW) && hunks.message.includes('the edit touches lines 3-4, 9 — Read(offset: 3, limit: 2) covers the first gap (unread: 3-4, 9)'), messageOf(hunks))

  const ctxCover = makeContext()
  primeRead(ctxCover, file, { offset: 12, limit: 1 })
  const half = await validate({ file_path: file, old_string: 'const v12 = 12\nconst v13 = 13', new_string: 'x' }, ctxCover)
  check('R8 a read covering part of the touched lines leaves a gap of the rest', !half.ok && half.message.includes('the edit touches lines 12-13 — Read(offset: 13, limit: 1) covers the gap'), messageOf(half))

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
  check('E1 the ledger of an older generation is reported as a read of the file before it last changed', !drifted.ok && drifted.message.includes(`The lines of ${file} read this session were of the file before it last changed; the edit touches line 5`), messageOf(drifted))
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
  check('L5 an unread line still refuses and writes nothing', !refused.ok && refused.message.includes(LAW) && readFileSync(file, 'utf8') === before, messageOf(refused))
  const appended = await edit({ file_path: file, append: 'const v7 = 7\n' }, makeContext())
  check('L6 an append still needs no read', appended.ok && readFileSync(file, 'utf8').endsWith('const v7 = 7\n'), messageOf(appended))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
