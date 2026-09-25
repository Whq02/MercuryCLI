#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-result-no-reread-home-'))
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
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const editModule = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileEditTool } = editModule
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 500 ? `${detail.slice(0, 500)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the result-no-reread proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-result-no-reread-fixture-'))
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
const PARENT = { uuid: '00000000-0000-0000-0000-000000000008', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string; isError: boolean } | { ok: false; message: string }
async function run(tool: unknown, input: Record<string, unknown>, ctx: Ctx, id: string): Promise<Verdict> {
  const t = tool as { validateInput: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  const verdict = await t.validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  try {
    const out = await t.call(input, ctx, null, PARENT)
    const block = t.mapToolResultToToolResultBlockParam(out.data, id)
    return { ok: true, text: typeof block.content === 'string' ? block.content : '', isError: block.is_error === true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const edit = (input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> => run(FileEditTool, input, ctx, 'toolu_edit')
const write = (path: string, content: string, ctx: Ctx): Promise<Verdict> => run(FileWriteTool, { file_path: path, content }, ctx, 'toolu_write')
const textOf = (v: Verdict): string => (v.ok ? v.text : v.message)
const contentOf = (p: string): string => readFileSync(p, 'utf8').replaceAll('\r\n', '\n')
const SENTENCE = 'The change is applied and its lines count as read (a failed call would have errored); no Read is needed before the next edit.'
const carries = (v: Verdict): boolean => v.ok && v.text.includes(SENTENCE)
const oneSentence = (v: Verdict): boolean => v.ok && v.text.split(SENTENCE).length === 2
const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

section('A. THE EXPORTED SENTENCE — one constant, the words pinned')
{
  const note = (editModule as { APPLIED_NO_REREAD_NOTE?: unknown }).APPLIED_NO_REREAD_NOTE
  check('A1 the Edit tool module exports the sentence (RED on the base: no such export)', typeof note === 'string' && note === SENTENCE, JSON.stringify(note))
  check('A2 it is one sentence with no line break', SENTENCE.split('. ').length === 1 && !SENTENCE.includes('\n'))
}

section('B. EVERY EDIT SUCCESS CARRIES IT ONCE (RED on the base: absent)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'edits.txt')
  const ctx = makeContext()
  await write(file, body, ctx)
  const exact = await edit({ file_path: file, old_string: 'line 3', new_string: 'line three' }, ctx)
  check('B1 the exact-string success carries the sentence after the success clause', carries(exact) && oneSentence(exact) && exact.ok && exact.text.startsWith(`The file ${file} has been updated successfully. ${SENTENCE}`), textOf(exact))
  const all = await edit({ file_path: file, old_string: 'line 1', new_string: 'row 1', replace_all: true }, ctx)
  check('B2 the replace_all success carries it after its own clause', carries(all) && oneSentence(all) && all.ok && all.text.startsWith(`The file ${file} has been updated. All occurrences of the string were replaced. ${SENTENCE}`), textOf(all))
  const anchored = await edit({ file_path: file, expected_anchor: mintFileAnchor(contentOf(file)), hunks: [{ lines: '5', replace: 'line five' }] }, ctx)
  check('B3 the hunks-lane success carries it', carries(anchored) && oneSentence(anchored) && contentOf(file).includes('line five'), textOf(anchored))
  const appended = await edit({ file_path: file, append: 'line 13' }, ctx)
  check('B4 the append success carries it', carries(appended) && oneSentence(appended) && contentOf(file).endsWith('\nline 13'), textOf(appended))
  const sectioned = join(fixtures, 'sections.md')
  await write(sectioned, '# Top\n\n## One\n\nold body\n\n## Two\n\nother\n', ctx)
  const replaced = await edit({ file_path: sectioned, section: '## One', new_string: '## One\n\nnew body\n' }, ctx)
  check('B5 the section success carries it', carries(replaced) && oneSentence(replaced) && contentOf(sectioned).includes('new body'), textOf(replaced))
  const created = await edit({ file_path: join(fixtures, 'made-by-edit.txt'), old_string: '', new_string: 'fresh\n' }, ctx)
  check('B6 an Edit that creates a file carries it', carries(created) && oneSentence(created), textOf(created))
}

section('C. BOTH WRITE SUCCESSES CARRY IT ONCE (RED on the base: absent)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'written.txt')
  const ctx = makeContext()
  const created = await write(file, 'first\n', ctx)
  check('C1 the create result keeps its first line and carries the sentence on the next', carries(created) && oneSentence(created) && created.ok && created.text === `File created successfully at: ${file}\n${SENTENCE}`, textOf(created))
  const updated = await write(file, 'second\n', ctx)
  check('C2 the update result carries it after the success clause', carries(updated) && oneSentence(updated) && updated.ok && updated.text === `The file ${file} has been updated successfully. ${SENTENCE}`, textOf(updated))
}

section('D. NEVER ON A REFUSAL OR A NO-CHANGE')
{
  _resetSeenLinesForTesting()
  const unread = join(fixtures, 'unread.txt')
  writeFileSync(unread, body)
  const refused = await edit({ file_path: unread, old_string: 'line 2', new_string: 'line two' }, makeContext())
  check('D1 the read-first refusal does not carry it', !refused.ok && !refused.message.includes(SENTENCE), textOf(refused))
  const notFound = await edit({ file_path: unread, old_string: 'nowhere', new_string: 'x' }, makeContext())
  check('D2 a not-found refusal does not carry it', !notFound.ok && !notFound.message.includes(SENTENCE), textOf(notFound))
  const overwrite = await write(unread, 'other\n', makeContext())
  check('D3 the Write twin\'s read-first refusal does not carry it', !overwrite.ok && !overwrite.message.includes(SENTENCE), textOf(overwrite))
  const ctx = makeContext()
  const same = join(fixtures, 'same.txt')
  await write(same, body, ctx)
  const noChangeWrite = await write(same, body, ctx)
  check('D4 a Write that changes nothing does not carry it', noChangeWrite.ok && noChangeWrite.text.startsWith('No changes were made to') && !noChangeWrite.text.includes(SENTENCE), textOf(noChangeWrite))
  const noChangeEdit = await edit({ file_path: same, expected_anchor: mintFileAnchor(contentOf(same)), hunks: [{ lines: '4', replace: 'line 4' }] }, ctx)
  check('D5 an Edit that changes nothing does not carry it', noChangeEdit.ok && noChangeEdit.text.startsWith('No changes made to') && !noChangeEdit.text.includes(SENTENCE), textOf(noChangeEdit))
  const modifiedCtx = Object.assign(makeContext(), { userModifiedInput: true })
  const accepted = join(fixtures, 'user-modified.txt')
  await write(accepted, body, modifiedCtx)
  const userModified = await edit({ file_path: accepted, old_string: 'line 6', new_string: 'line six' }, modifiedCtx)
  check('D6 an edit the user modified before accepting says so and does not carry it: the model never saw the user\'s version', userModified.ok && userModified.text.includes('(the user modified the change before accepting it)') && !userModified.text.includes(SENTENCE), textOf(userModified))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
