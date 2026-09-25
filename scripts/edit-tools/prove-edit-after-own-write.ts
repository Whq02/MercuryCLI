#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-after-own-write-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
delete process.env.MERCURY_EDIT_STALE_RECOVERY
delete process.env.NODE_ENV

let foreignWriteDuringSave: { path: string; content: string } | null = null
const managerPath = new URL('../../src/services/lsp/manager.ts', import.meta.url).pathname
const realManagerModule = await import(managerPath)
const fakeManager = {
  async changeAndSaveFile(path: string): Promise<void> {
    if (foreignWriteDuringSave !== null && foreignWriteDuringSave.path === path) {
      await new Promise(resolve => setTimeout(resolve, 5))
      writeFileSync(path, foreignWriteDuringSave.content)
      foreignWriteDuringSave = null
    }
  },
}
mock.module(managerPath, () => ({ ...realManagerModule, getLspServerManager: () => fakeManager }))

const { fileGeneration, seenLinesOf, _resetSeenLinesForTesting } = await import('../../src/services/changeTransaction/seenLines.ts')
const { processMainOwner, processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FILE_UNEXPECTEDLY_MODIFIED_ERROR } = await import('../../src/tools/FileEditTool/constants.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 600 ? `${detail.slice(0, 600)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the edit-after-own-write proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-after-own-write-fixture-'))
type Entry = { content: string; timestamp: number; offset?: number; limit?: number; isPartialView?: boolean }
type Ctx = { readFileState: Map<string, Entry> }
function makeContext(agentId?: string): Ctx {
  return {
    readFileState: new Map<string, Entry>(),
    ...(agentId === undefined ? {} : { agentId }),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000007', message: { id: 'msg_fixture' } }
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
async function write(path: string, content: string, ctx: Ctx): Promise<Verdict> {
  const input = { file_path: path, content }
  const verdict = await (FileWriteTool as { validateInput: Function }).validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  try {
    const out = await (FileWriteTool as { call: Function }).call(input, ctx, null, PARENT)
    const block = (FileWriteTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_write')
    return { ok: true, text: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const messageOf = (v: Verdict): string => (v.ok ? `(landed) ${v.text.slice(0, 200)}` : v.message)
const contentOf = (p: string): string => readFileSync(p, 'utf8').replaceAll('\r\n', '\n')
const owner = processMainOwner()
const TWELVE_TIMES = 'The lines the edit touches are below and count as read: edit again without a Read.'
const UNREAD_WRITE = 'Read the file before overwriting it — a prior read of the current content is required.'
const body = (n: number): string => Array.from({ length: n }, (_, i) => `const w${i + 1} = ${i + 1}`).join('\n') + '\n'
const wholeLedger = (file: string, lastLine: number): boolean => {
  const ledger = seenLinesOf(owner, file)
  return ledger !== undefined && ledger.generation === fileGeneration(file) && ledger.ranges.some(r => r.start === 1 && r.end === lastLine)
}

section('A. THE RESUMED OWNER\'S OWN WRITE — Write in one context, then a fresh context (an empty read cache, the same owner) edits the file with a byte-exact old_string (RED on the base)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'written.ts')
  const before = makeContext()
  const created = await write(file, body(30), before)
  check('A1 the Write lands as a creation', created.ok && contentOf(file) === body(30), messageOf(created))
  check('A2 the Write stamps the owner ledger with every line it wrote, at the generation it produced (RED on the base: no ledger entry)', wholeLedger(file, 30), JSON.stringify({ ledger: seenLinesOf(owner, file), generation: fileGeneration(file) }))
  const resumed = makeContext()
  const first = await edit({ file_path: file, old_string: 'const w7 = 7', new_string: 'const w7 = 70' }, resumed)
  check('A3 the fresh context\'s first exact edit of the file it wrote lands without a Read (RED on the base: refused with the twelve-times lead)', first.ok && contentOf(file).includes('const w7 = 70'), messageOf(first))
  check('A4 …and no refusal named the file as unread', first.ok || (!first.message.includes(TWELVE_TIMES) && !first.message.includes(`No lines of ${file} were read this session`)), messageOf(first))
  const second = await edit({ file_path: file, old_string: 'const w25 = 25', new_string: 'const w25 = 250' }, resumed)
  check('A5 the next edit in the fresh context lands on the entry the first edit refreshed', second.ok && contentOf(file).includes('const w25 = 250'), messageOf(second))
  check('A6 the ledger followed the edits: its generation is the file\'s and it still covers the whole file', wholeLedger(file, 30), JSON.stringify({ ledger: seenLinesOf(owner, file), generation: fileGeneration(file) }))
  const entry = resumed.readFileState.get(file)
  check('A7 the fresh context now holds the file as a full read entry', entry !== undefined && entry.offset === undefined && entry.limit === undefined && entry.content === contentOf(file), JSON.stringify({ offset: entry?.offset, limit: entry?.limit }))
}

section('B. THE SAME CONTEXT WITH THE READ ENTRY GONE — a pruned read cache after the owner\'s own Write (RED on the base)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'pruned.ts')
  const ctx = makeContext()
  await write(file, body(12), ctx)
  ctx.readFileState.delete(file)
  const landed = await edit({ file_path: file, old_string: 'const w3 = 3', new_string: 'const w3 = 33' }, ctx)
  check('B1 with the read entry dropped the edit still lands: the ledger vouches for the file the tool itself wrote (RED on the base)', landed.ok && contentOf(file).includes('const w3 = 33'), messageOf(landed))
}

section('C. THE WRITE TWIN — a fresh context overwrites the file the same owner wrote (RED on the base)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'twin.md')
  const before = makeContext()
  await write(file, '# Report\n\nfirst draft\n', before)
  const resumed = makeContext()
  const again = await write(file, '# Report\n\nsecond draft\n', resumed)
  check('C1 the fresh context\'s Write of the file the owner wrote lands as an update (RED on the base: "Read the file before overwriting it")', again.ok && contentOf(file) === '# Report\n\nsecond draft\n', messageOf(again))
  check('C2 …and no refusal asked for a read first', again.ok || !again.message.includes(UNREAD_WRITE), messageOf(again))
  check('C3 the ledger stands at the generation the second Write produced and covers the whole new file', wholeLedger(file, 3), JSON.stringify({ ledger: seenLinesOf(owner, file), generation: fileGeneration(file) }))
  const third = await write(file, '# Report\n\nthird draft\n', resumed)
  check('C4 the next Write in the fresh context lands on the entry the second one refreshed', third.ok && contentOf(file) === '# Report\n\nthird draft\n', messageOf(third))
}

section('D. THE LAW KEPT — bytes the owner never observed still refuse, word for word')
{
  _resetSeenLinesForTesting()
  const other = join(fixtures, 'other-road.ts')
  writeFileSync(other, body(20))
  const ctx = makeContext()
  const unread = await edit({ file_path: other, old_string: 'const w4 = 4', new_string: 'const w4 = 44' }, ctx)
  check('D1 a file made by another road, never read, refuses with the twelve-times lead', !unread.ok && unread.message.startsWith(TWELVE_TIMES) && unread.message.includes(`No lines of ${other} were read this session`), messageOf(unread))
  check('D2 …and nothing was written', !contentOf(other).includes('const w4 = 44'))
  const retried = await edit({ file_path: other, old_string: 'const w4 = 4', new_string: 'const w4 = 44' }, ctx)
  check('D3 the retry after the refusal\'s carry lands (the carried lines were shown for the current generation)', retried.ok && contentOf(other).includes('const w4 = 44'), messageOf(retried))
  const overwrite = await write(other, body(3), makeContext())
  check('D4 a Write over a file whose current bytes the owner never observed whole still refuses', !overwrite.ok && overwrite.message === UNREAD_WRITE, messageOf(overwrite))

  _resetSeenLinesForTesting()
  const shared = join(fixtures, 'shared.ts')
  await write(shared, body(30), makeContext())
  writeFileSync(shared, contentOf(shared).replace('const w20 = 20', 'const w20 = 20 + 1'))
  const later = new Date(Date.now() + 120_000)
  utimesSync(shared, later, later)
  const changed = await edit({ file_path: shared, old_string: 'const w7 = 7', new_string: 'const w7 = 77' }, makeContext())
  check('D5 after the owner\'s Write another writer changed the file: a fresh context\'s edit refuses (the ledger\'s generation is not the file\'s)', !changed.ok && changed.message.includes('The edit needs a prior read of the current content'), messageOf(changed))
  check('D6 …the refusal names the change (RED on the base: it says no lines were read)', !changed.ok && changed.message.startsWith(`The file ${shared} changed after the lines you read`) && changed.message.includes('File generation check failed: earlier read coverage belongs to the file before it changed.'), messageOf(changed))
  check('D7 …and nothing was written', !contentOf(shared).includes('const w7 = 77'))
  const twinChanged = await write(shared, body(2), makeContext())
  check('D8 the Write twin on the changed file refuses too', !twinChanged.ok && twinChanged.message === UNREAD_WRITE, messageOf(twinChanged))

  _resetSeenLinesForTesting()
  const mismatch = join(fixtures, 'mismatch.ts')
  await write(mismatch, body(10), makeContext())
  const wrong = await edit({ file_path: mismatch, old_string: 'const w5 = 55', new_string: 'const w5 = 5' }, makeContext())
  check('D9 an old_string that does not match the current bytes is refused as not found and nothing is written', !wrong.ok && wrong.message.includes('the old_string was not found in the current content') && contentOf(mismatch) === body(10), messageOf(wrong))
}

section('E. ANOTHER OWNER\'S WRITE IS NOT THIS OWNER\'S READ — a sub-agent\'s Write does not vouch for the main owner\'s edit')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'agent-written.ts')
  const agentContext = makeContext('agentfixture')
  const agentWrite = await write(file, body(15), agentContext)
  const agentLedger = seenLinesOf(processOwnerForLane('agentfixture'), file)
  check('E1 the sub-agent\'s Write stamps the sub-agent owner\'s ledger (RED on the base)', agentWrite.ok && agentLedger !== undefined && agentLedger.generation === fileGeneration(file), JSON.stringify(agentLedger))
  const parent = await edit({ file_path: file, old_string: 'const w2 = 2', new_string: 'const w2 = 22' }, makeContext())
  check('E2 the main owner\'s fresh context is refused with the twelve-times lead: it never observed the bytes', !parent.ok && parent.message.startsWith(TWELVE_TIMES) && parent.message.includes(`No lines of ${file} were read this session`), messageOf(parent))
  check('E3 …and nothing was written', !contentOf(file).includes('const w2 = 22'))
}

section('F. THE ONE-CONTEXT ROAD — Write then Edit in the same context lands, base and tip alike')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'same-context.ts')
  const ctx = makeContext()
  await write(file, body(8), ctx)
  const landed = await edit({ file_path: file, old_string: 'const w8 = 8', new_string: 'const w8 = 88' }, ctx)
  check('F1 the edit right after the Write in the same context lands', landed.ok && contentOf(file).includes('const w8 = 88'), messageOf(landed))
}

const foreign = Array.from({ length: 24 }, (_, i) => `const FOREIGN${i + 1} = ${i + 1}`).join('\n') + '\n'

section('G. A FOREIGN WRITE INSIDE THE WRITE\'S OWN SAVE AWAIT — the stamp is the bytes the tool wrote, so the foreign bytes are never counted as seen')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'raced-by-write.ts')
  const ctx = makeContext()
  foreignWriteDuringSave = { path: file, content: foreign }
  const raced = await write(file, body(8), ctx)
  check('G1 the Write itself lands and the foreign bytes are on disk afterwards', raced.ok && foreignWriteDuringSave === null && contentOf(file) === foreign, messageOf(raced))
  const ledger = seenLinesOf(owner, file)
  check('G2 the ledger stands at the generation of the bytes the tool wrote, not the file\'s foreign generation', ledger !== undefined && ledger.generation !== fileGeneration(file), JSON.stringify({ ledger, generation: fileGeneration(file) }))
  const sameWrite = await write(file, 'clobbered\n', ctx)
  check('G3 the same context\'s next Write refuses as modified since the read (RED on the base: the read state was stamped after the await)', !sameWrite.ok && sameWrite.message === FILE_UNEXPECTEDLY_MODIFIED_ERROR && contentOf(file) === foreign, messageOf(sameWrite))
  const sameEdit = await edit({ file_path: file, old_string: 'const FOREIGN10 = 10', new_string: 'const FOREIGN10 = 100' }, ctx)
  check('G4 the same context\'s next Edit refuses as modified too (RED on the base)', !sameEdit.ok && sameEdit.message === FILE_UNEXPECTEDLY_MODIFIED_ERROR && contentOf(file) === foreign, messageOf(sameEdit))
  const freshWrite = await write(file, 'clobbered\n', makeContext())
  check('G5 a fresh context\'s Write over the foreign bytes refuses and writes nothing', !freshWrite.ok && freshWrite.message === UNREAD_WRITE && contentOf(file) === foreign, messageOf(freshWrite))
  const freshEdit = await edit({ file_path: file, old_string: 'const FOREIGN10 = 10', new_string: 'const FOREIGN10 = 100' }, makeContext())
  check('G6 a fresh context\'s Edit of a foreign line refuses and writes nothing', !freshEdit.ok && contentOf(file) === foreign, messageOf(freshEdit))
}

section('H. A FOREIGN WRITE INSIDE THE EDIT\'S OWN SAVE AWAIT — the Edit\'s stamp closes the same way (RED on the base)')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'raced-by-edit.ts')
  const ctx = makeContext()
  await write(file, body(8), ctx)
  foreignWriteDuringSave = { path: file, content: foreign }
  const raced = await edit({ file_path: file, old_string: 'const w2 = 2', new_string: 'const w2 = 22' }, ctx)
  check('H1 the Edit itself lands and the foreign bytes are on disk afterwards', raced.ok && foreignWriteDuringSave === null && contentOf(file) === foreign, messageOf(raced))
  const ledger = seenLinesOf(owner, file)
  check('H2 the ledger stands at the generation of the bytes the Edit wrote, not the foreign one (RED on the base)', ledger !== undefined && ledger.generation !== fileGeneration(file), JSON.stringify({ ledger, generation: fileGeneration(file) }))
  const sameEdit = await edit({ file_path: file, old_string: 'const FOREIGN10 = 10', new_string: 'const FOREIGN10 = 100' }, ctx)
  check('H3 the same context\'s next Edit refuses as modified since the read (RED on the base)', !sameEdit.ok && sameEdit.message === FILE_UNEXPECTEDLY_MODIFIED_ERROR && contentOf(file) === foreign, messageOf(sameEdit))
  const freshWrite = await write(file, 'clobbered\n', makeContext())
  check('H4 a fresh context\'s Write over the foreign bytes refuses and writes nothing', !freshWrite.ok && freshWrite.message === UNREAD_WRITE && contentOf(file) === foreign, messageOf(freshWrite))
  const freshEdit = await edit({ file_path: file, old_string: 'const FOREIGN10 = 10', new_string: 'const FOREIGN10 = 100' }, makeContext())
  check('H5 a fresh context\'s Edit of a foreign line refuses and writes nothing (RED on the base: it lands)', !freshEdit.ok && contentOf(file) === foreign, messageOf(freshEdit))
}

section('I. THE SAVE AWAIT WITH NO FOREIGN WRITE — the stamp taken before the await still vouches after it')
{
  _resetSeenLinesForTesting()
  const file = join(fixtures, 'quiet-save.ts')
  await write(file, body(6), makeContext())
  const edited = await edit({ file_path: file, old_string: 'const w6 = 6', new_string: 'const w6 = 66' }, makeContext())
  check('I1 with a manager present and no race, the fresh context\'s edit of the written file lands', edited.ok && contentOf(file).includes('const w6 = 66'), messageOf(edited))
  const again = await edit({ file_path: file, old_string: 'const w1 = 1', new_string: 'const w1 = 11' }, makeContext())
  check('I2 …and a fresh context\'s edit of the edited file lands after it', again.ok && contentOf(file).includes('const w1 = 11'), messageOf(again))
  check('I3 the ledger names the file\'s current generation', wholeLedger(file, 6), JSON.stringify({ ledger: seenLinesOf(owner, file), generation: fileGeneration(file) }))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
