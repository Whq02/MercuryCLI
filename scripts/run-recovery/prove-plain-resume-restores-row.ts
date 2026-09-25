#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'plain-resume-row-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'plain-resume-row-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_BARE
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_SESSION_HOME

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'plain-resume-row-repo-')))
const worktree = join(workspace, 'worktrees', 'wt')
mkdirSync(worktree, { recursive: true })
process.chdir(worktree)

const j = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x === undefined ? 'undefined' : x))
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

const state = await import('../../src/bootstrap/state.ts')
state.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getProjectDir, getTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const { getProject } = await import('../../src/utils/sessionStorage/writer.ts')
const { clearSessionMetadata } = await import('../../src/utils/sessionStorage/logs.ts')
const { getCurrentWorktreeSession } = await import('../../src/utils/worktree.ts')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')
const { loadInitialMessages } = await import('../../src/cli/headless/resume.ts')
const { asSessionId } = await import('../../src/types/ids.ts')

const MODEL = 'claude-fable-5-1'
const SID = '00000000-0000-4000-8000-00000000c0de'
const U_FIRST = '00000000-0000-4000-8000-000000000001'
const U_REPLY = '00000000-0000-4000-8000-000000000002'
const TITLE = 'the parser rewrite'
const TAG = 'parser'
const AGENT = 'scribe'
const COLOR = 'blue'
const SETTING = 'reviewer'
const MODE = 'coordinator'
const PR = { prNumber: 41, prUrl: 'https://example.invalid/pr/41', prRepository: 'example/repo' }
const worktreeRecord = { originalCwd: workspace, worktreePath: worktree, worktreeName: 'wt', worktreeBranch: 'wt', originalBranch: 'main', sessionId: SID }
const lawHome = getProjectDir(workspace)
mkdirSync(lawHome, { recursive: true })
const transcriptPath = join(lawHome, `${SID}.jsonl`)
const noop = (): void => {}
const stamp = (n: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 30_000).toISOString()
const envelope = (n: number, parentUuid: string | null, row: Record<string, unknown>): Record<string, unknown> => ({
  parentUuid,
  isSidechain: false,
  cwd: worktree,
  sessionId: SID,
  version: '1.0.0',
  gitBranch: 'wt',
  timestamp: stamp(n),
  ...row,
})
const rows: Array<Record<string, unknown>> = [
  envelope(0, null, { type: 'user', uuid: U_FIRST, message: { role: 'user', content: 'first' } }),
  envelope(1, U_FIRST, {
    type: 'assistant',
    uuid: U_REPLY,
    requestId: 'req_first',
    message: { id: 'msg_first', type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
  }),
  { type: 'custom-title', customTitle: TITLE, sessionId: SID },
  { type: 'tag', tag: TAG, sessionId: SID },
  { type: 'agent-name', agentName: AGENT, sessionId: SID },
  { type: 'agent-color', agentColor: COLOR, sessionId: SID },
  { type: 'agent-setting', agentSetting: SETTING, sessionId: SID },
  { type: 'mode', mode: MODE, sessionId: SID },
  { type: 'worktree-state', worktreeSession: worktreeRecord, sessionId: SID },
  { type: 'pr-link', sessionId: SID, ...PR, timestamp: stamp(3) },
]
const factsOf = (r: { customTitle?: string; tag?: string; agentName?: string; agentColor?: string; agentSetting?: string; mode?: string; worktreeSession?: { worktreePath: string } | null; prNumber?: number; prUrl?: string; prRepository?: string } | null) =>
  r === null ? null : { title: r.customTitle, tag: r.tag, agentName: r.agentName, agentColor: r.agentColor, agentSetting: r.agentSetting, mode: r.mode, worktree: r.worktreeSession?.worktreePath, pr: [r.prNumber, r.prUrl, r.prRepository] }
const cacheFacts = () => {
  const p = getProject()
  return factsOf({
    customTitle: p.currentSessionTitle,
    tag: p.currentSessionTag,
    agentName: p.currentSessionAgentName,
    agentColor: p.currentSessionAgentColor,
    agentSetting: p.currentSessionAgentSetting,
    mode: p.currentSessionMode,
    worktreeSession: p.currentSessionWorktree,
    prNumber: p.currentSessionPrNumber,
    prUrl: p.currentSessionPrUrl,
    prRepository: p.currentSessionPrRepository,
  })
}
const RED = 'RED WHERE THE FILE ROAD DROPS THE ROW'
const wanted = { title: TITLE, tag: TAG, agentName: AGENT, agentColor: COLOR, agentSetting: SETTING, mode: MODE, worktree: worktree, pr: [PR.prNumber, PR.prUrl, PR.prRepository] }

section('§1 the transcript — the writer\'s row family under the law home, folded by the one reader')
writeFileSync(transcriptPath, rows.map(r => encodeTranscriptLine(transcriptPath, r).line).join(''))
check('the transcript stands under the workspace\'s project dir (the law home), not the worktree\'s', existsSync(transcriptPath) && lawHome !== getProjectDir(worktree))
const fold = await loadTranscriptFile(transcriptPath)
check('the fold holds every row: title, tag, agent name, colour, setting, mode, worktree state, PR link', fold.customTitles.get(SID as never) === TITLE && fold.tags.get(SID as never) === TAG && fold.agentNames.get(SID as never) === AGENT && fold.agentColors.get(SID as never) === COLOR && fold.agentSettings.get(SID as never) === SETTING && fold.modes.get(SID as never) === MODE && fold.worktreeStates.get(SID as never)?.worktreePath === worktree && fold.prNumbers.get(SID as never) === PR.prNumber, j({ title: fold.customTitles.get(SID as never), mode: fold.modes.get(SID as never), worktree: fold.worktreeStates.get(SID as never) }))

section('§2 the loader\'s file road — the road a pinned home takes — must carry the facts the fold holds')
const byFile = await loadConversationForResume(SID, transcriptPath)
check('the file road loads the conversation and names the tip\'s session', byFile !== null && byFile.messages.length === 2 && byFile.sessionId === SID, j({ messages: byFile?.messages.length, sessionId: byFile?.sessionId }))
check(`${RED}: the file road carries the worktree record`, byFile?.worktreeSession?.worktreePath === worktree, `worktreeSession=${j(byFile?.worktreeSession)}`)
check(`${RED}: the file road carries the title, the agent name and the mode`, byFile?.customTitle === TITLE && byFile?.agentName === AGENT && byFile?.mode === MODE, j({ customTitle: byFile?.customTitle, agentName: byFile?.agentName, mode: byFile?.mode }))
check(`${RED}: the file road carries the agent setting, the colour, the tag and the PR link`, byFile?.agentSetting === SETTING && byFile?.agentColor === COLOR && byFile?.tag === TAG && byFile?.prNumber === PR.prNumber && byFile?.prUrl === PR.prUrl && byFile?.prRepository === PR.prRepository, j(factsOf(byFile)))
check('the file road still carries no fullPath (the explicit-path road keeps its own home)', byFile?.fullPath === undefined, j(byFile?.fullPath))

section('§3 the daemon\'s cold resume — the plain road as the runner boots it: cwd inside the worktree, the home pinned, --resume <id>')
clearSessionMetadata()
process.env.MERCURY_SESSION_HOME = lawHome
const before = { cwd: process.cwd(), originalCwd: state.getOriginalCwd(), worktree: getCurrentWorktreeSession() }
const loaded = await loadInitialMessages(noop, { continue: undefined, resume: SID, resumeSessionAt: undefined, forkSession: undefined, outputFormat: 'text' })
check('the runner adopts the transcript\'s session and its two rows', loaded.messages.length === 2 && state.getSessionId() === SID, j({ messages: loaded.messages.length, sessionId: state.getSessionId() }))
check('the home pin was consumed once and scrubbed', process.env.MERCURY_SESSION_HOME === undefined)
check(`${RED}: the resumed runner's cache holds the title, the tag, the agent name, colour and setting, the mode, the worktree record and the PR link`, j(cacheFacts()) === j(wanted), `cache=${j(cacheFacts())}`)
check(`${RED}: the runner's agent restore receives the recorded agent setting`, loaded.agentSetting === SETTING, `agentSetting=${j(loaded.agentSetting)}`)
check(`${RED}: the runner writes on to the law home's transcript, the file it loaded`, getTranscriptPath() === transcriptPath && state.getSessionProjectDir() === lawHome, j({ writes: getTranscriptPath(), loaded: transcriptPath, sessionProjectDir: state.getSessionProjectDir() }))
check('the control: the runner did not re-enter the worktree it already sits in (cwd, originalCwd and the worktree slot unmoved)', process.cwd() === before.cwd && state.getOriginalCwd() === before.originalCwd && getCurrentWorktreeSession() === null && before.worktree === null, j({ before, after: { cwd: process.cwd(), originalCwd: state.getOriginalCwd(), worktree: getCurrentWorktreeSession() } }))

section('§4 the control — the session-id road (a shell resume in the workspace) carries the facts it always carried, on both trees')
clearSessionMetadata()
state.switchSession(asSessionId(SID), lawHome)
const byId = await loadConversationForResume(SID, undefined)
check('the session-id road carries the title, the tag, the agent setting and the worktree record', byId?.customTitle === TITLE && byId?.tag === TAG && byId?.agentSetting === SETTING && byId?.worktreeSession?.worktreePath === worktree && byId?.fullPath === transcriptPath, j(factsOf(byId)))
check('the two roads agree on those facts', byId?.customTitle === byFile?.customTitle && byId?.tag === byFile?.tag && byId?.agentSetting === byFile?.agentSetting && byId?.worktreeSession?.worktreePath === byFile?.worktreeSession?.worktreePath, j({ byId: factsOf(byId), byFile: factsOf(byFile) }))

console.log(`\n${failures === 0 ? '✅' : '❌'} plain resume restores the row: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
