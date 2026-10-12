#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'refusal-another-session-home-'))
process.env.MERCURY_DAEMON_DIR = join(process.env.MERCURY_CONFIG_DIR, 'daemon')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.NODE_ENV

const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FILE_UNEXPECTEDLY_MODIFIED_ERROR } = await import('../../src/tools/FileEditTool/constants.ts')
const other = (await import('../../src/tools/FileEditTool/otherSession.ts').catch(() => null)) as typeof import('../../src/tools/FileEditTool/otherSession.ts') | null
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getProjectRoot, getSessionId } = await import('../../src/bootstrap/state.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.length > 700 ? `${detail.slice(0, 700)}…` : detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const NOTE = "may be another session's work"
const OTHER_SID = 'aaaaaaaa-1111-4222-8333-444444444444'
const OTHER_STARTED = 1_760_000_000_000
const OTHER_STARTED_ISO = new Date(OTHER_STARTED).toISOString()
const workersFile = join(process.env.MERCURY_DAEMON_DIR, 'concourse-workers.json')
function liveWorkers(rows: Array<{ sessionId: string; spawnedAt: number }>): void {
  mkdirSync(process.env.MERCURY_DAEMON_DIR!, { recursive: true })
  const workers: Record<string, unknown> = {}
  rows.forEach((row, index) => {
    workers[`w${index + 1}`] = { sessionId: row.sessionId, workspaceId: getProjectRoot(), pid: process.pid, spawnedAt: row.spawnedAt }
  })
  writeFileSync(workersFile, JSON.stringify({ version: 1, workers }))
}
function noWorkers(): void {
  rmSync(workersFile, { force: true })
}

const fixtures = mkdtempSync(join(tmpdir(), 'refusal-another-session-fixture-'))
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
const PARENT = { uuid: '00000000-0000-0000-0000-000000000007', message: { id: 'msg_fixture' } }
type Verdict = { ok: true; text: string } | { ok: false; message: string }
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<Verdict> {
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  try {
    await (FileEditTool as { call: Function }).call(input, ctx, null, PARENT)
    return { ok: true, text: '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
async function write(path: string, content: string, ctx: Ctx): Promise<Verdict> {
  const input = { file_path: path, content }
  const verdict = await (FileWriteTool as { validateInput: Function }).validateInput(input, ctx)
  if (verdict.result === false) return { ok: false, message: String(verdict.message) }
  try {
    await (FileWriteTool as { call: Function }).call(input, ctx, null, PARENT)
    return { ok: true, text: '' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const messageOf = (v: Verdict): string => (v.ok ? `(ok)` : v.message)
let serial = 0
function fileWith(content: string): string {
  const path = join(fixtures, `f${++serial}.md`)
  writeFileSync(path, content)
  return path
}

section('A. no other session live — the refusal names the possibility, nothing more')
{
  noWorkers()
  const file = fileWith('# Report\n\nfirst draft\n')
  const w = await write(file, '# Report\n\nsecond draft\n', makeContext())
  check('A1 a Write over an existing file never read in this session is refused', !w.ok)
  check(`A1 …and says it may be another session's work (RED on the base: "a prior read of the current content is required" alone)`, !w.ok && w.message.includes(NOTE) && w.message.startsWith('Read the file before overwriting it'), messageOf(w))
  check('A1 …without naming a live session (none is)', !w.ok && !w.message.includes('is live:') && !w.message.includes('are live:'), messageOf(w))
  const e = await edit({ file_path: file, old_string: 'first draft', new_string: 'second draft' }, makeContext())
  check('A2 an Edit of a file never read in this session is refused', !e.ok)
  check(`A2 …and says it may be another session's work, and shows no line of the file`, !e.ok && e.message.startsWith(`Read the file before editing it — it exists and was not read in this session, so it may be another session's work`) && !/\n\d+\t/.test(e.message), messageOf(e))
  check('A3 the changed-since-read sentence names the possibility too (RED on the base)', FILE_UNEXPECTEDLY_MODIFIED_ERROR.includes(NOTE) && FILE_UNEXPECTEDLY_MODIFIED_ERROR.startsWith('The file changed on disk after your last read'), FILE_UNEXPECTEDLY_MODIFIED_ERROR)
}

section('B. another session of this project is live — the refusal names it and its start time')
{
  liveWorkers([{ sessionId: OTHER_SID, spawnedAt: OTHER_STARTED }])
  const file = fileWith('# Report\n\nfirst draft\n')
  const w = await write(file, '# Report\n\nsecond draft\n', makeContext())
  check(`B1 the Write refusal names the other session by its first eight characters and its start time (RED on the base)`, !w.ok && w.message.includes(`Another session of this project is live: ${OTHER_SID.slice(0, 8)} since ${OTHER_STARTED_ISO}.`), messageOf(w))
  const e = await edit({ file_path: file, old_string: 'first draft', new_string: 'second draft' }, makeContext())
  check('B2 the Edit refusal names it too', !e.ok && e.message.includes(`Another session of this project is live: ${OTHER_SID.slice(0, 8)} since ${OTHER_STARTED_ISO}.`), messageOf(e))

  const read = fileWith('# Notes\n\nline one\n')
  const ctx = makeContext()
  const before = Date.now() - 60_000
  ctx.readFileState.set(read, { content: '# Notes\n\nline one\n', timestamp: before })
  writeFileSync(read, '# Notes\n\nline one, changed by another hand\n')
  utimesSync(read, new Date(), new Date())
  const stale = await write(read, '# Notes\n\nline one, mine\n', ctx)
  check('B3 a Write after the file changed on disk is refused as modified and names the live session', !stale.ok && stale.message.startsWith(FILE_UNEXPECTEDLY_MODIFIED_ERROR) && stale.message.includes(`is live: ${OTHER_SID.slice(0, 8)} since ${OTHER_STARTED_ISO}`), messageOf(stale))
  const staleEdit = await edit({ file_path: read, old_string: 'line one', new_string: 'line two' }, ctx)
  check('B4 an Edit after the file changed on disk is refused as modified and names the live session', !staleEdit.ok && staleEdit.message.startsWith(FILE_UNEXPECTEDLY_MODIFIED_ERROR) && staleEdit.message.includes(`is live: ${OTHER_SID.slice(0, 8)} since ${OTHER_STARTED_ISO}`), messageOf(staleEdit))

  liveWorkers([{ sessionId: OTHER_SID, spawnedAt: OTHER_STARTED }, { sessionId: 'bbbbbbbb-1111-4222-8333-444444444444', spawnedAt: OTHER_STARTED + 120_000 }])
  const two = await write(fileWith('x\n'), 'y\n', makeContext())
  check('B5 two live sessions are both named, in the order they started', !two.ok && two.message.includes(`Other sessions of this project are live: ${OTHER_SID.slice(0, 8)} since ${OTHER_STARTED_ISO}, bbbbbbbb since ${new Date(OTHER_STARTED + 120_000).toISOString()}.`), messageOf(two))
}

section('C. the session itself is never "another session"')
{
  liveWorkers([{ sessionId: String(getSessionId()), spawnedAt: OTHER_STARTED }])
  const w = await write(fileWith('x\n'), 'y\n', makeContext())
  check('C1 a live row carrying this session\'s own id adds no clause', !w.ok && w.message.includes(NOTE) && !w.message.includes('is live:') && !w.message.includes('are live:'), messageOf(w))
  check('C2 the clause builder answers the empty string then', other !== null && other.otherLiveSessionsClause() === '', other === null ? 'module absent' : other.otherLiveSessionsClause())
  noWorkers()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} refusal names another session: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
