#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'session-knowledge-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'session-knowledge-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_ENTRYPOINT = 'headless'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_BARE
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_SESSION_HOME

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'session-knowledge-repo-')))
process.chdir(workspace)

const state = await import('../../src/bootstrap/state.ts')
state.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const ledger = await import('../../src/services/changeTransaction/seenLines.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { clearSessionMetadata } = await import('../../src/utils/sessionStorage/logs.ts')
const { loadInitialMessages } = await import('../../src/cli/headless/resume.ts')

let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
type Ctx = { readFileState: Map<string, unknown>; agentId?: string }
function makeContext(agentId?: string): Ctx {
  return {
    ...(agentId === undefined ? {} : { agentId }),
    readFileState: new Map(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    setAppState: () => {},
    options: { tools: [], commands: [], mcpClients: [], mcpResources: {} },
  } as unknown as Ctx
}
const PARENT = { uuid: '00000000-0000-0000-0000-000000000006', message: { id: 'msg_fixture' } }
type Caller = { call: Function; validateInput: Function; mapToolResultToToolResultBlockParam: Function }
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: boolean; words: string }> {
  const tool = FileEditTool as unknown as Caller
  const verdict = await tool.validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, words: String(verdict.message) }
  try {
    const out = await tool.call(input, ctx, null, PARENT)
    const block = tool.mapToolResultToToolResultBlockParam(out.data, 'toolu_fixture')
    return { ok: true, words: typeof block.content === 'string' ? block.content : '' }
  } catch (err) {
    return { ok: false, words: err instanceof Error ? err.message : String(err) }
  }
}
async function write(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: boolean; words: string }> {
  const tool = FileWriteTool as unknown as Caller
  try {
    const out = await tool.call(input, ctx, null, PARENT)
    const block = tool.mapToolResultToToolResultBlockParam(out.data, 'toolu_write')
    return { ok: true, words: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
  } catch (err) {
    return { ok: false, words: err instanceof Error ? err.message : String(err) }
  }
}
async function readResult(input: Record<string, unknown>, ctx: Ctx): Promise<string> {
  const tool = FileReadTool as unknown as Caller
  const out = await tool.call(input, ctx, null, PARENT)
  const block = tool.mapToolResultToToolResultBlockParam(out.data, 'toolu_read')
  return typeof block.content === 'string' ? block.content : ''
}
const fixtures = join(workspace, 'src')
mkdirSync(fixtures, { recursive: true })

section("§1 the session's own crewmate wrote the file in this process: main edits it without a Read (the field row 2A-02)")
{
  const notePath = join(fixtures, 'crew-note.md')
  const body = 'alpha one\nalpha two\nalpha three\n'
  const crewWrite = await write({ file_path: notePath, content: body }, makeContext('crew-1'))
  check("the crewmate's Write lands", crewWrite.ok, crewWrite.words)
  const mainEdit = await edit({ file_path: notePath, old_string: 'alpha two', new_string: 'alpha 2' }, makeContext())
  check("main's Edit of the file its crewmate wrote lands with no Read of its own", mainEdit.ok && !mainEdit.words.includes('not read in this session'), mainEdit.words)
  const otherSession = 'alpha 2\nalpha three\n'
  const mainWrite = await write({ file_path: notePath, content: otherSession }, makeContext())
  check("main's Write over the file lands too: the session knows the bytes its own lanes wrote", mainWrite.ok, mainWrite.words)
}

section("§2 a crewmate's Read is its own knowledge; only the lines it authored are the session's")
{
  const reportPath = join(fixtures, 'report.md')
  writeFileSync(reportPath, Array.from({ length: 8 }, (_, i) => `line ${i + 1} of the report`).join('\n') + '\n')
  const crew = makeContext('crew-2')
  await readResult({ file_path: reportPath }, crew)
  const crewEdit = await edit({ file_path: reportPath, old_string: 'line 6 of the report', new_string: 'line 6, written by the crewmate' }, crew)
  check('the crewmate reads the file and edits line 6', crewEdit.ok, crewEdit.words)
  const mainSees = ledger.seenLinesOf(processMainOwner(), reportPath)?.ranges ?? []
  check("main's ledger holds the line the crewmate authored and none it only read", mainSees.some(r => r.start <= 6 && 6 <= r.end) && !mainSees.some(r => r.start <= 2 && 2 <= r.end), j(mainSees))
  const onAuthored = await edit({ file_path: reportPath, old_string: 'line 6, written by the crewmate', new_string: 'line 6, then by main' }, makeContext())
  check('main edits the line the crewmate authored without a Read', onAuthored.ok, onAuthored.words)
  const onRead = await edit({ file_path: reportPath, old_string: 'line 2 of the report', new_string: 'line 2 by main' }, makeContext())
  check('a line the crewmate only read lands for main by the partly-read law (the carry reads it through in the same call)', onRead.ok, onRead.words)
}

section('§3 the restart after a partial Read, on the headless resume road (the field row 2S-03)')
{
  const SID = '00000000-0000-4000-8000-00000000c0de'
  const partialPath = join(fixtures, 'partial-c.txt')
  writeFileSync(partialPath, 'alpha one\nalpha two\nalpha three\nalpha four\n')
  const earlier = makeContext()
  const shown = await readResult({ file_path: partialPath, offset: 1, limit: 2 }, earlier)
  check('the earlier process read lines 1-2 of 4 (a partial Read)', shown.includes('2\talpha two') && /lines 1-2 of 4/.test(shown), shown)
  ledger._resetSeenLinesForTesting()
  const bootId = String(state.getSessionId())
  const bootOwner = processMainOwner()
  check('the restarted process boots under a provisional id, not the session it will resume', bootId !== SID, bootId)
  const lawHome = getProjectDir(workspace)
  mkdirSync(lawHome, { recursive: true })
  const transcriptPath = join(lawHome, `${SID}.jsonl`)
  const stamp = (n: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 30_000).toISOString()
  const U1 = '00000000-0000-4000-8000-000000000001'
  const A1 = '00000000-0000-4000-8000-000000000002'
  const U2 = '00000000-0000-4000-8000-000000000003'
  const A2 = '00000000-0000-4000-8000-000000000004'
  const envelope = (n: number, parentUuid: string | null, row: Record<string, unknown>): Record<string, unknown> => ({ parentUuid, isSidechain: false, cwd: workspace, sessionId: SID, version: '1.0.0', gitBranch: 'main', timestamp: stamp(n), ...row })
  const rows = [
    envelope(0, null, { type: 'user', uuid: U1, message: { role: 'user', content: 'read the first two lines of partial-c.txt' } }),
    envelope(1, U1, { type: 'assistant', uuid: A1, requestId: 'req_1', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: partialPath, offset: 1, limit: 2 } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    envelope(2, A1, { type: 'user', uuid: U2, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: shown }] } }),
    envelope(3, U2, { type: 'assistant', uuid: A2, requestId: 'req_2', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'Lines 1-2 read.' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]
  writeFileSync(transcriptPath, rows.map(r => encodeTranscriptLine(transcriptPath, r).line).join(''))
  clearSessionMetadata()
  process.env.MERCURY_SESSION_HOME = lawHome
  const loaded = await loadInitialMessages(() => {}, { continue: undefined, resume: SID, resumeSessionAt: undefined, forkSession: undefined, outputFormat: 'text' })
  check('the resume road adopts the transcript and its session id', loaded.messages.length === 4 && String(state.getSessionId()) === SID, j({ messages: loaded.messages.length, sessionId: String(state.getSessionId()) }))
  const seen = ledger.seenLinesOf(processMainOwner(), partialPath)
  const underBoot = ledger.seenLinesOf(bootOwner, partialPath)
  console.log(`  fence: the rebuild's owner — under the boot id ${j(underBoot?.ranges ?? null)}, under the resumed session ${j(seen?.ranges ?? null)}`)
  check("the resumed session's own ledger carries the two lines the partial Read showed", seen !== undefined && seen.ranges.some(r => r.start <= 1 && r.end >= 2), j(seen))
  const afterRestart = await edit({ file_path: partialPath, old_string: 'alpha two', new_string: 'alpha 2' }, makeContext())
  check('the Edit on line 2 lands after the restart with no new Read', afterRestart.ok, afterRestart.words)
  const afterEdit = ledger.seenLinesOf(processMainOwner(), partialPath)?.ranges ?? []
  check('the ledger after the edit still holds the window', afterEdit.some(r => r.start <= 1 && 2 <= r.end), j(afterEdit))
  const outsideWindow = await edit({ file_path: partialPath, old_string: 'alpha four', new_string: 'alpha 4' }, makeContext())
  check('a line outside the partial window lands by the partly-read law (the carry reads it through in the same call)', outsideWindow.ok, outsideWindow.words)
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('SESSION KNOWLEDGE LEDGER RED')
  process.exit(1)
}
console.log('SESSION KNOWLEDGE LEDGER GREEN')
