#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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

const state = await import('../../src/boot/process-state/processState.ts')
state.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { clearSystemPromptSections } = await import('../../src/engine/system-prompt/systemPromptSections.ts')
const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/models/roads/toolEconomy.ts')
const { boundPrefixRecordToEmit, resetBoundPrefixEmitted } = await import('../../src/models/roads/anthropic/boundPrefixRecord.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { RETAIN_TOOL_NAME } = await import('../../src/tools/kit/names/memory.ts')
const { RECORD_CONVENTION_TOOL_NAME } = await import('../../src/tools/record-convention/prompt.ts')
const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const sessionRestore = await import('../../src/sessions/resume/sessionRestore.ts')
const { restoreSessionStateFromListing } = sessionRestore
const { restoreSessionMetadata } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { restoreWorktreeSession, getCurrentWorktreeSession } = await import('../../src/platform/git/worktree/worktree.ts')
const { asSessionId } = await import('../../src/sessions/transcripts/ids.ts')

const MODEL = 'claude-fable-5-1'
const SID = '00000000-0000-4000-8000-0000000c0ded'
const U_FIRST = '00000000-0000-4000-8000-000000000001'
const U_REPLY = '00000000-0000-4000-8000-000000000002'
const U_RECORD = '00000000-0000-4000-8000-000000000003'
const BULLET = ` (${RETAIN_TOOL_NAME} with pin)`
const STALE = 'STALE SECTION FROM ANOTHER CONVERSATION'
const tool = (name: string): { name: string } => ({ name })
const firstPool = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate', 'Skill', 'AskUserQuestion', RECORD_CONVENTION_TOOL_NAME].map(tool)
const grownPool = [...firstPool, ...[RETAIN_TOOL_NAME, 'Recall', 'Correct'].map(tool)]
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
const plainRoad = async (loaded: Awaited<ReturnType<typeof load>>): Promise<void> => {
  state.switchSession(asSessionId(loaded.sessionId), dirname(loaded.fullPath!))
  await restoreSessionStateFromListing(loaded, noop)
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
  check('the control: the first request names the worktree and carries no Retain pin clause (no Retain in the pool)', first.includes(' - This working directory is an isolated copy of the repository (a git worktree); every command runs here, never in the original repository root.') && first.includes(`Working directory: ${worktree}`) && !first.includes(BULLET), 'the first prompt lacks the worktree line, the working directory or carries the pin clause; check getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts (the getCurrentWorktreeSession branch) and that the fixture entered the worktree')
  await planToolPayload({ model: MODEL, tools: firstPool as never, messages: [firstRow] as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
  const row = await boundPrefixRecordToEmit(owner, [firstRow] as never, MODEL)
  check('the first exchange emits its record with the cached sections', row !== null && row.attachment.type === 'bound_prefix' && (row.attachment as { sections: unknown[] }).sections.length > 0, 'boundPrefixRecordToEmit in src/models/roads/anthropic/boundPrefixRecord.ts returned no bound_prefix record or one without sections after planToolPayload')
  const record = JSON.parse(j(row!.attachment)) as Record<string, unknown> & { sections: Array<{ name: string; value: string | null }> }
  const recordedRunProtocol = record.sections.find(s => s.name === 'project_estate')?.value ?? null
  check('the record carries the project-estate section as first sent', recordedRunProtocol !== null && !recordedRunProtocol.includes(BULLET), 'the emitted record has no project_estate section or it holds the pin clause; look at the sections boundPrefixRecordToEmit records in src/models/roads/anthropic/boundPrefixRecord.ts')
  writeTranscript(record)

  section('§2 the plain road — the loader restores the record, the session state and the metadata follow; the resumed prefix is the recorded bytes')
  freshProcess()
  const plain = await load()
  check('the transcript resolves through the session-id road and carries the worktree record', plain.worktreeSession?.worktreePath === worktree && plain.fullPath === transcriptPath, j({ worktree: plain.worktreeSession, fullPath: plain.fullPath }))
  await plainRoad(plain)
  const plainResumed = await build(grownPool)
  check('the plain road re-sends the first request byte for byte although the memory tools joined the pool', plainResumed === first, firstDifference(first, plainResumed) + ' | the resume must reuse the recorded sections: see restoreBoundPrefixFromMessages in src/models/roads/anthropic/boundPrefixRecord.ts and its call in src/sessions/resume/conversationRecovery.ts')

  section('§3 the plain road inside the recorded worktree — the runner already sits there, as the daemon spawns it; nothing after the loader re-decides a section')
  freshProcess()
  sitInWorktree()
  const recorded = await load()
  await plainRoad(recorded)
  check('the control: the runner sits in the worktree and nothing re-entered it (the cwd stays, the in-memory worktree slot stays null, the record is in the cache)', process.cwd() === worktree && state.getOriginalCwd() === worktree && getCurrentWorktreeSession() === null && recorded.worktreeSession?.worktreePath === worktree, j({ cwd: process.cwd(), worktree: getCurrentWorktreeSession() }))
  const cachedRunProtocol = state.getSystemPromptSectionCache().get('project_estate')?.value ?? null
  check('the section cache still holds the record\'s project-estate bytes after the resume inside the worktree', cachedRunProtocol === recordedRunProtocol, `cache holds ${state.getSystemPromptSectionCache().size} section(s) after the resume; project_estate=${j(cachedRunProtocol?.slice(0, 80) ?? null)}`)
  const worktreeResumed = await build(grownPool)
  check('the resume inside the worktree re-sends the first request byte for byte — no Retain pin clause rendered from the live pool', worktreeResumed === first && !worktreeResumed.includes(BULLET), firstDifference(first, worktreeResumed) + ' | a section was rendered again after the loader seeded the record: see restoreBoundPrefixFromMessages in src/models/roads/anthropic/boundPrefixRecord.ts and src/sessions/resume/conversationRecovery.ts')
  check('the plain road sends identical prefix bytes from the repo and from inside the worktree', worktreeResumed === plainResumed, firstDifference(plainResumed, worktreeResumed) + ' | the prefix must not depend on where the runner sits: see src/sessions/resume/conversationRecovery.ts and src/sessions/resume/sessionRestore.ts')

  section('§4 the control — a transcript without a record on the plain road renders the live world (the pool\'s truth), never a section from elsewhere')
  writeTranscript(null)
  freshProcess()
  sitInWorktree()
  const recordless = await load()
  check('the recordless transcript carries no record row', !recordless.messages.some(m => m.type === 'attachment' && (m as { attachment: { type: string } }).attachment.type === 'bound_prefix'), 'the recordless fixture still yields a bound_prefix row; check writeTranscript(null) in this file and loadConversationForResume in src/sessions/resume/conversationRecovery.ts')
  check('the loader seeded nothing: a fresh process resuming a recordless transcript holds no section', state.getSystemPromptSectionCache().size === 0, `${state.getSystemPromptSectionCache().size} section(s) | loadConversationForResume in src/sessions/resume/conversationRecovery.ts must seed sections only from a recorded bound_prefix`)
  await plainRoad(recordless)
  const recordlessResumed = await build(grownPool)
  check('a fresh process resuming a recordless transcript renders the pool\'s truth: the pin clause appears', recordlessResumed.includes(BULLET), firstDifference(first, recordlessResumed) + ' | with no record the prompt must be built from the live pool: see getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts and the cache seeding in src/sessions/resume/conversationRecovery.ts')
  freshProcess()
  sitInWorktree()
  state.setSystemPromptSectionCacheEntry('project_estate', STALE, null)
  const unguarded = await load()
  await plainRoad(unguarded)
  const unguardedResumed = await build(grownPool)
  check('the hazard, shown: a warm process that built a prompt before its claim and then loads a recordless transcript WITHOUT the claim\'s clear serves the stale section in the resumed prefix', unguardedResumed.includes(STALE) && !unguardedResumed.includes(BULLET), firstDifference(first, unguardedResumed) + ' | this control expects the stale section to survive without clearSystemPromptSections; if it no longer does, the loader now clears the cache itself and the control must be revisited')
  freshProcess()
  sitInWorktree()
  state.setSystemPromptSectionCacheEntry('project_estate', STALE, null)
  const RED_WARM = 'RED WHERE THE WARM CLAIM CLEARS NO SECTION'
  clearSystemPromptSections()
  const claimed = await load()
  await plainRoad(claimed)
  const claimedResumed = await build(grownPool)
  check(`${RED_WARM}: with the claim's clear ahead of the load, a recordless warm claim renders the pool's truth — the pin clause appears and no stale bytes stand`, !claimedResumed.includes(STALE) && claimedResumed.includes(BULLET), firstDifference(first, claimedResumed) + ' | clearSystemPromptSections (src/engine/system-prompt/systemPromptSections.ts) ahead of the load must leave no stale section; check that function and what the loader seeds in src/sessions/resume/conversationRecovery.ts')
  freshProcess()
  sitInWorktree()
  writeTranscript(record)
  state.setSystemPromptSectionCacheEntry('project_estate', STALE, null)
  state.setSystemPromptSectionCacheEntry('stale_extra_section', STALE, null)
  clearSystemPromptSections()
  const recordedClaim = await load()
  await plainRoad(recordedClaim)
  const recordedClaimResumed = await build(grownPool)
  check('a recorded warm claim: the clear ahead of the load leaves only the record\'s sections plus the live ones — the first request is byte-identical to the first exchange and no extra section survives', recordedClaimResumed === first && !state.getSystemPromptSectionCache().has('stale_extra_section') && state.getSystemPromptSectionCache().get('project_estate')?.value === recordedRunProtocol, firstDifference(first, recordedClaimResumed) + ' | after the clear the record must reseed only its own sections: see restoreBoundPrefixFromMessages in src/models/roads/anthropic/boundPrefixRecord.ts and clearSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts')

  section('§5 the retirement — the plain road is the one restore; the recorded-worktree entry and its re-entry helpers are gone')
  check('the surviving restore steps stay exported: the state and the metadata restores', typeof sessionRestore.restoreSessionStateFromListing === 'function' && typeof restoreSessionMetadata === 'function' && typeof sessionRestore.restoreAgentFromSession === 'function', 'restoreSessionStateFromLog and restoreAgentFromSession must stay exported from src/sessions/resume/sessionRestore.ts and restoreSessionMetadata from src/sessions/transcripts/sessionStorage.ts')
} finally {
  freshProcess()
}

console.log(`\n${failures === 0 ? '✅' : '❌'} worktree resume keeps the record: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
