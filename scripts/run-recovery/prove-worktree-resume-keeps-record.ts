#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'worktree-resume-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'worktree-resume-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_BARE
delete process.env.MERCURY_MODEL

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-resume-repo-')))
const worktree = join(repo, 'worktrees', 'wt')
mkdirSync(worktree, { recursive: true })
process.chdir(repo)

const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function firstDifference(a: string, b: string): string {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return `differ at char ${at}: ${j(a.slice(Math.max(0, at - 60), at + 120))} vs ${j(b.slice(Math.max(0, at - 60), at + 120))}`
}

const state = await import('../../src/bootstrap/state.ts')
state.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
const { boundPrefixRecordToEmit, resetBoundPrefixEmitted } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { TASK_CREATE_TOOL_NAME } = await import('../../src/tools/TaskCreateTool/constants.ts')
const { RECORD_CONVENTION_TOOL_NAME } = await import('../../src/tools/RecordConventionTool/prompt.ts')
const { REMEMBER_LESSON_TOOL_NAME } = await import('../../src/tools/RememberLessonTool/prompt.ts')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')
const sessionRestore = await import('../../src/utils/sessionRestore.ts')
const { restoreSessionStateFromLog } = sessionRestore
const { restoreSessionMetadata } = await import('../../src/utils/sessionStorage.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { restoreWorktreeSession, getCurrentWorktreeSession } = await import('../../src/utils/worktree.ts')
const { asSessionId } = await import('../../src/types/ids.ts')

const MODEL = 'claude-fable-5-1'
const SID = '00000000-0000-4000-8000-0000000c0ded'
const U_FIRST = '00000000-0000-4000-8000-000000000001'
const U_REPLY = '00000000-0000-4000-8000-000000000002'
const U_RECORD = '00000000-0000-4000-8000-000000000003'
const BULLET = 'Break down and manage work with the'
const STALE = 'STALE SECTION FROM ANOTHER CONVERSATION'
const tool = (name: string): { name: string } => ({ name })
const firstPool = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'Skill', 'AskUserQuestion', RECORD_CONVENTION_TOOL_NAME, REMEMBER_LESSON_TOOL_NAME].map(tool)
const grownPool = [...firstPool, ...[TASK_CREATE_TOOL_NAME, 'TaskGet', 'TaskList', 'TaskUpdate'].map(tool)]
const owner = 'worktree-resume'
const firstRow = { type: 'user', uuid: U_FIRST, message: { role: 'user', content: 'first' } }
const text = (parts: string[]): string => parts.join('\n\n')
const build = async (pool: Array<{ name: string }>): Promise<string> => text(await getSystemPrompt(pool as never, MODEL))
const worktreeRecord = { originalCwd: repo, worktreePath: worktree, worktreeName: 'wt', sessionId: SID }
const projectDir = getProjectDir(repo)
mkdirSync(projectDir, { recursive: true })
const transcriptPath = join(projectDir, `${SID}.jsonl`)
const noop = (): void => {}

const freshProcess = (): void => {
  clearSystemPromptSections()
  clearToolRosterLatches()
  clearToolRosterRestore()
  resetBoundPrefixEmitted()
  restoreWorktreeSession(null)
  process.chdir(repo)
  state.setOriginalCwd(repo)
  state.setCwdState(repo)
}
const enterWorktree = (): void => {
  process.chdir(worktree)
  state.setOriginalCwd(worktree)
  state.setCwdState(worktree)
  restoreWorktreeSession(worktreeRecord)
}
const stamp = (n: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 30_000).toISOString()
const envelope = (n: number, parentUuid: string | null, row: Record<string, unknown>): Record<string, unknown> => ({
  parentUuid,
  isSidechain: false,
  cwd: worktree,
  sessionId: SID,
  version: '1.0.0',
  gitBranch: 'main',
  timestamp: stamp(n),
  ...row,
})
const writeTranscript = (record: Record<string, unknown> | null): void => {
  const rows: Array<Record<string, unknown>> = [
    envelope(0, null, firstRow),
    envelope(1, U_FIRST, {
      type: 'assistant',
      uuid: U_REPLY,
      requestId: 'req_first',
      message: { id: 'msg_first', type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    ...(record !== null ? [envelope(2, U_REPLY, { type: 'attachment', uuid: U_RECORD, attachment: record })] : []),
    { type: 'worktree-state', worktreeSession: worktreeRecord, sessionId: SID },
  ]
  writeFileSync(transcriptPath, rows.map(r => encodeTranscriptLine(transcriptPath, r).line).join(''))
}
const load = async () => {
  const loaded = await loadConversationForResume(SID, undefined)
  if (loaded === null) throw new Error('the loader returned null for the fixture transcript')
  return loaded
}
const plainRoad = (loaded: Awaited<ReturnType<typeof load>>): void => {
  state.switchSession(asSessionId(loaded.sessionId), dirname(loaded.fullPath!))
  restoreSessionStateFromLog(loaded, noop)
  restoreSessionMetadata(loaded)
}
const sitInWorktree = (): void => {
  process.chdir(worktree)
  state.setOriginalCwd(worktree)
  state.setCwdState(worktree)
}

try {
  section('§1 the first process — the first exchange is made inside the worktree and writes its record')
  state.switchSession(asSessionId(SID), projectDir)
  freshProcess()
  enterWorktree()
  const first = await build(firstPool)
  check('the control: the first request names the worktree and carries no work-breakdown bullet (no task tool in the pool)', first.includes('isolated copy of the repository') && first.includes(`Primary working directory: ${worktree}`) && !first.includes(BULLET))
  await planToolPayload({ model: MODEL, tools: firstPool as never, messages: [firstRow] as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
  const row = await boundPrefixRecordToEmit(owner, [firstRow] as never, MODEL)
  check('the first exchange emits its record with the cached sections', row !== null && row.attachment.type === 'bound_prefix' && (row.attachment as { sections: unknown[] }).sections.length > 0)
  const record = JSON.parse(j(row!.attachment)) as Record<string, unknown> & { sections: Array<{ name: string; value: string | null }> }
  const recordedUsingTools = record.sections.find(s => s.name === 'using_tools')?.value ?? null
  check('the record carries the "Using your tools" section as first sent', recordedUsingTools !== null && !recordedUsingTools.includes(BULLET))
  writeTranscript(record)

  section('§2 the plain road — the loader restores the record, the session state and the metadata follow; the resumed prefix is the recorded bytes')
  freshProcess()
  const plain = await load()
  check('the transcript resolves through the session-id road and carries the worktree record', plain.worktreeSession?.worktreePath === worktree && plain.fullPath === transcriptPath, j({ worktree: plain.worktreeSession, fullPath: plain.fullPath }))
  plainRoad(plain)
  const plainResumed = await build(grownPool)
  check('the plain road re-sends the first request byte for byte although the task tools joined the pool', plainResumed === first, firstDifference(first, plainResumed))

  section('§3 the plain road inside the recorded worktree — the runner already sits there, as the daemon spawns it; nothing after the loader re-decides a section')
  freshProcess()
  sitInWorktree()
  const recorded = await load()
  plainRoad(recorded)
  check('the control: the runner sits in the worktree and nothing re-entered it (the cwd stays, the in-memory worktree slot stays null, the record is in the cache)', process.cwd() === worktree && state.getOriginalCwd() === worktree && getCurrentWorktreeSession() === null && recorded.worktreeSession?.worktreePath === worktree, j({ cwd: process.cwd(), worktree: getCurrentWorktreeSession() }))
  const cachedUsingTools = state.getSystemPromptSectionCache().get('using_tools')?.value ?? null
  check('the section cache still holds the record\'s "Using your tools" bytes after the resume inside the worktree', cachedUsingTools === recordedUsingTools, `cache holds ${state.getSystemPromptSectionCache().size} section(s) after the resume; using_tools=${j(cachedUsingTools?.slice(0, 80) ?? null)}`)
  const worktreeResumed = await build(grownPool)
  check('the resume inside the worktree re-sends the first request byte for byte — no work-breakdown bullet rendered from the live pool', worktreeResumed === first && !worktreeResumed.includes(BULLET), firstDifference(first, worktreeResumed))
  check('the plain road sends identical prefix bytes from the repo and from inside the worktree', worktreeResumed === plainResumed, firstDifference(plainResumed, worktreeResumed))

  section('§4 the control — a transcript without a record on the plain road renders the live world (the pool\'s truth), never a section from elsewhere')
  writeTranscript(null)
  freshProcess()
  sitInWorktree()
  const recordless = await load()
  check('the recordless transcript carries no record row', !recordless.messages.some(m => m.type === 'attachment' && (m as { attachment: { type: string } }).attachment.type === 'bound_prefix'))
  check('the loader seeded nothing: a fresh process resuming a recordless transcript holds no section', state.getSystemPromptSectionCache().size === 0, `${state.getSystemPromptSectionCache().size} section(s)`)
  plainRoad(recordless)
  const recordlessResumed = await build(grownPool)
  check('a recordless resume renders the pool\'s truth: the bullet appears and no stale bytes stand', !recordlessResumed.includes(STALE) && recordlessResumed.includes(BULLET), firstDifference(first, recordlessResumed))

  section('§5 the retirement — the plain road is the one restore; the recorded-worktree entry and its re-entry helpers are gone')
  const RED = 'RED WHERE THE RETIRED ENTRY STILL STANDS'
  const retired = ['processResumed' + 'Conversation', 'restoreWorktree' + 'ForResume', 'exitRestored' + 'Worktree', 'invalidateWorktree' + 'SensitiveCaches', 'carriesBound' + 'PrefixRecord', 'Processed' + 'Resume']
  const restoreSrc = readFileSync(join(import.meta.dir, '../../src/utils/sessionRestore.ts'), 'utf8')
  check(`${RED}: sessionRestore.ts exports no resume entry and no worktree re-entry`, !(retired[0]! in sessionRestore) && retired.every(name => !restoreSrc.includes(name)), retired.filter(name => restoreSrc.includes(name)).join(', '))
  check(`${RED}: sessionRestore.ts moves no directory and clears no cache (the plain road restores; the world's moves reach the model on new rows)`, !restoreSrc.includes('process.chdir(') && !restoreSrc.includes('clearSystemPromptSectionState') && !restoreSrc.includes('clearInstructionFileCaches'), restoreSrc.split('\n').filter(l => /chdir|clear/.test(l)).join(' | '))
  check('the surviving restore steps stay exported: the state and the metadata restores', typeof sessionRestore.restoreSessionStateFromLog === 'function' && typeof restoreSessionMetadata === 'function' && typeof sessionRestore.restoreAgentFromSession === 'function')
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : []))
  const here = join(import.meta.dir, 'prove-worktree-resume-keeps-record.ts')
  const naming = [...walk(join(import.meta.dir, '../../src')), ...walk(join(import.meta.dir, '../../scripts'))].filter(f => f !== here && readFileSync(f, 'utf8').includes(retired[0]!))
  check(`${RED}: nothing under src or scripts names the retired entry`, naming.length === 0, naming.map(f => f.slice(f.indexOf('/src/') === -1 ? f.indexOf('/scripts/') : f.indexOf('/src/'))).join(', '))
} finally {
  freshProcess()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} worktree resume keeps the record: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
