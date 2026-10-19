#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-restart-ledger-home-'))
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.NODE_ENV

const ledger = (await import('../../src/services/changeTransaction/seenLines.ts')) as typeof import('../../src/services/changeTransaction/seenLines.ts') & { rebuildSeenLinesFromTranscript?: (owner: unknown, messages: readonly unknown[]) => { files: number; lines: number } }
const { processMainOwner, processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const fixtures = mkdtempSync(join(tmpdir(), 'edit-restart-ledger-fixture-'))
type Ctx = { readFileState: Map<string, unknown> }
function makeContext(): Ctx {
  return { readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) } as never as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000006', message: { id: 'msg_fixture' } }
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: boolean; words: string }> {
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, words: String(verdict.message) }
  try {
    const out = await (FileEditTool as { call: Function }).call(input, ctx, null, PARENT)
    const block = (FileEditTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_fixture')
    return { ok: true, words: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, words: err instanceof Error ? err.message : String(err) }
  }
}
async function readResult(path: string, ctx: Ctx): Promise<string> {
  const out = await (FileReadTool as { call: Function }).call({ file_path: path, offset: 0, limit: 2000 }, ctx, null, PARENT)
  const block = (FileReadTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(out.data, 'toolu_read')
  return typeof block.content === 'string' ? block.content : ''
}
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1} of the report`).join('\n') + '\n'
const transcriptOf = (rows: Array<{ use: { id: string; name: string; input: Record<string, unknown> }; result: string }>): unknown[] =>
  rows.flatMap(row => [
    { type: 'assistant', uuid: `${row.use.id}-a`, message: { role: 'assistant', content: [{ type: 'tool_use', id: row.use.id, name: row.use.name, input: row.use.input }] } },
    { type: 'user', uuid: `${row.use.id}-u`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: row.use.id, content: row.result }] } },
  ])

section('§1 the session read a file before the restart: the lines its own Read showed count as read again (the field row M39-12)')
const owner = processMainOwner()
const readPath = join(fixtures, 'report.md')
writeFileSync(readPath, lines(12))
const shown = await readResult(readPath, makeContext())
ledger._resetSeenLinesForTesting()
{
  const refused = await edit({ file_path: readPath, old_string: 'line 3 of the report', new_string: 'line 3, edited' }, makeContext())
  check('after a restart (an empty ledger) the edit is refused as unread', !refused.ok && refused.words.includes('was not read in this session'), refused.words)
  const rebuilt = ledger.rebuildSeenLinesFromTranscript?.(owner, transcriptOf([{ use: { id: 'r1', name: 'Read', input: { file_path: readPath } }, result: shown }]))
  check('the transcript rebuilds the ledger: every shown line that still reads the same is seen', rebuilt !== undefined && rebuilt.files === 1 && rebuilt.lines === 12, j(rebuilt))
  const accepted = await edit({ file_path: readPath, old_string: 'line 3 of the report', new_string: 'line 3, edited' }, makeContext())
  check('the same edit now lands without a new Read', accepted.ok, accepted.words)
}

section('§2 a line that changed since the read stays unread; a file written whole by this session counts whole when it still matches')
{
  const movedPath = join(fixtures, 'moved.md')
  writeFileSync(movedPath, lines(6))
  const before = await readResult(movedPath, makeContext())
  writeFileSync(movedPath, lines(6).replace('line 4 of the report', 'line 4 rewritten by another hand'))
  ledger._resetSeenLinesForTesting()
  const rebuilt = ledger.rebuildSeenLinesFromTranscript?.(owner, transcriptOf([{ use: { id: 'r2', name: 'Read', input: { file_path: movedPath } }, result: before }]))
  check('five of six lines still read the same and count; the rewritten one does not', rebuilt !== undefined && rebuilt.lines === 5, j(rebuilt))
  const ranges = ledger.seenLinesOf(owner, movedPath)?.ranges ?? []
  check('the rewritten line is not in the ledger: the ranges skip line 4', ranges.length === 2 && !ranges.some(r => r.start <= 4 && 4 <= r.end), j(ranges))
  const onKept = await edit({ file_path: movedPath, old_string: 'line 2 of the report', new_string: 'line 2, kept and edited' }, makeContext())
  check('an edit on a line that still reads the same lands', onKept.ok, onKept.words)

  const writtenPath = join(fixtures, 'written.md')
  const body = lines(4)
  writeFileSync(writtenPath, body)
  ledger._resetSeenLinesForTesting()
  const crew = processOwnerForLane('a-crewmate-1')
  const rebuiltWrite = ledger.rebuildSeenLinesFromTranscript?.(crew, transcriptOf([{ use: { id: 'w1', name: 'Write', input: { file_path: writtenPath, content: body } }, result: `File written: ${writtenPath}` }]))
  check("a crewmate's own Write whose content still stands counts the whole file as seen for that crewmate", rebuiltWrite !== undefined && rebuiltWrite.files === 1 && ledger.wholeFileSeen(crew, writtenPath, body), j(rebuiltWrite))
  check("…and the session knows the bytes its crewmate wrote: the main thread's Write over the same file is not refused", ledger.wholeFileSeen(owner, writtenPath, body))
  writeFileSync(writtenPath, body + 'a fifth line\n')
  ledger._resetSeenLinesForTesting()
  const stale = ledger.rebuildSeenLinesFromTranscript?.(crew, transcriptOf([{ use: { id: 'w2', name: 'Write', input: { file_path: writtenPath, content: body } }, result: 'ok' }]))
  check('a Write whose content no longer matches the file counts nothing', stale !== undefined && stale.files === 0 && stale.lines === 0, j(stale))
}

section('§3 the resume roads call the rebuild')
{
  const ROOT = join(import.meta.dir, '..', '..')
  const recovery = readFileSync(join(ROOT, 'src/utils/conversationRecovery.ts'), 'utf8')
  const resume = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
  check("the session's resume rebuilds the main thread's ledger from its transcript under the resumed session's own id", recovery.includes('rebuildSeenLinesFromTranscript(sessionId === undefined ? processMainOwner() : mainOwnerOfSession(String(sessionId)), asMessages)'))
  check("a resumed crewmate's ledger is rebuilt from its own transcript under its own owner", resume.includes('rebuildSeenLinesFromTranscript(processOwnerForLane(agentId), transcript.messages)'))
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('EDIT AFTER RESTART LEDGER RED')
  process.exit(1)
}
console.log('EDIT AFTER RESTART LEDGER GREEN')
