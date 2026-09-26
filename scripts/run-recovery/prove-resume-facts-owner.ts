#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'resume-facts-owner-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'resume-facts-owner-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_BARE
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_SESSION_HOME

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'resume-facts-owner-repo-')))
process.chdir(workspace)

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
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const { buildConversationChain } = await import('../../src/utils/sessionStorage/chain.ts')
const logs = await import('../../src/utils/sessionStorage/logs.ts')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.ts')

const MODEL = 'claude-fable-5-1'
const SID = '00000000-0000-4000-8000-00000000fac7'
const U_FIRST = '00000000-0000-4000-8000-000000000001'
const U_REPLY = '00000000-0000-4000-8000-000000000002'
const TITLE = 'the parser rewrite'
const TAG = 'parser'
const AGENT = 'scribe'
const COLOR = 'blue'
const SETTING = 'reviewer'
const MODE = 'coordinator'
const PR = { prNumber: 41, prUrl: 'https://example.invalid/pr/41', prRepository: 'example/repo' }
const worktreeRecord = { originalCwd: workspace, worktreePath: join(workspace, 'worktrees', 'wt'), worktreeName: 'wt', worktreeBranch: 'wt', originalBranch: 'main', sessionId: SID }
const home = getProjectDir(workspace)
mkdirSync(home, { recursive: true })
const transcriptPath = join(home, `${SID}.jsonl`)
const stamp = (n: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 30_000).toISOString()
const envelope = (n: number, parentUuid: string | null, row: Record<string, unknown>): Record<string, unknown> => ({
  parentUuid,
  isSidechain: false,
  cwd: workspace,
  sessionId: SID,
  version: '1.0.0',
  gitBranch: 'main',
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
  { type: 'file-history-snapshot', messageId: U_REPLY, snapshot: { messageId: U_REPLY, trackedFileBackups: {}, timestamp: stamp(2) }, isSnapshotUpdate: false },
  { type: 'content-replacement', sessionId: SID, replacements: [{ toolUseId: 'toolu_first', replacement: 'the stored result' }] },
  { type: 'context-collapse-commit', sessionId: SID, collapseId: 'c1', summaryUuid: 'u-summary', summaryContent: '[collapsed]', summary: 'the first exchange', firstArchivedUuid: U_FIRST, lastArchivedUuid: U_REPLY },
  { type: 'context-collapse-snapshot', sessionId: SID, staged: [], armed: false, lastSpawnTokens: 0 },
  { type: 'custom-title', customTitle: TITLE, sessionId: SID },
  { type: 'tag', tag: TAG, sessionId: SID },
  { type: 'agent-name', agentName: AGENT, sessionId: SID },
  { type: 'agent-color', agentColor: COLOR, sessionId: SID },
  { type: 'agent-setting', agentSetting: SETTING, sessionId: SID },
  { type: 'mode', mode: MODE, sessionId: SID },
  { type: 'worktree-state', worktreeSession: worktreeRecord, sessionId: SID },
  { type: 'pr-link', sessionId: SID, ...PR, timestamp: stamp(3) },
]
type Facts = Partial<Record<(typeof FACT_KEYS)[number], unknown>>
const FACT_KEYS = ['fileHistorySnapshots', 'attributionSnapshots', 'contentReplacements', 'contextCollapseCommits', 'contextCollapseSnapshot', 'agentName', 'agentColor', 'agentSetting', 'customTitle', 'tag', 'mode', 'worktreeSession', 'prNumber', 'prUrl', 'prRepository'] as const
const factsOf = (r: Facts | null | undefined): Record<string, unknown> | null => {
  if (r === null || r === undefined) return null
  const out: Record<string, unknown> = {}
  for (const k of FACT_KEYS) out[k] = r[k]
  return out
}
const RED = 'RED WHERE A READER KEEPS ITS OWN DERIVATION'

section('§1 the fixture — one transcript carrying every fact the fold folds, read once by the one reader')
writeFileSync(transcriptPath, rows.map(r => encodeTranscriptLine(transcriptPath, r).line).join(''))
const fold = await loadTranscriptFile(transcriptPath)
const leaf = fold.messages.get(U_REPLY as never)
check('the fold holds the two rows and every fact row', fold.messages.size === 2 && leaf !== undefined && fold.customTitles.get(SID as never) === TITLE && fold.agentNames.get(SID as never) === AGENT && fold.modes.get(SID as never) === MODE && fold.worktreeStates.get(SID as never)?.worktreePath === worktreeRecord.worktreePath && fold.prNumbers.get(SID as never) === PR.prNumber && fold.fileHistorySnapshots.size === 1 && (fold.contentReplacements.get(SID as never)?.length ?? 0) === 1 && fold.contextCollapseCommits.length === 1 && fold.contextCollapseSnapshot !== undefined, j({ messages: fold.messages.size, title: fold.customTitles.get(SID as never), snapshots: fold.fileHistorySnapshots.size, commits: fold.contextCollapseCommits.length }))
const chain = buildConversationChain(fold.messages, leaf!)
const owner = factsOf(logs.resumeFactsOf(fold, SID as never, chain))
check('the owner derives every fact for the session: the snapshot chain, the replacements, the collapse facts, the row family', owner !== null && (owner.fileHistorySnapshots as unknown[]).length === 1 && (owner.contentReplacements as unknown[]).length === 1 && (owner.contextCollapseCommits as unknown[]).length === 1 && owner.contextCollapseSnapshot !== undefined && owner.customTitle === TITLE && owner.tag === TAG && owner.agentName === AGENT && owner.agentColor === COLOR && owner.agentSetting === SETTING && owner.mode === MODE && (owner.worktreeSession as { worktreePath: string }).worktreePath === worktreeRecord.worktreePath && owner.prNumber === PR.prNumber && owner.prUrl === PR.prUrl && owner.prRepository === PR.prRepository, j(owner))

section('§2 the four resume readers hand back the owner\'s facts byte for byte')
const byId = await logs.getLastSessionLog(SID as never)
check('the session-id road (the last-log accessor) reads the owner', byId !== null && j(factsOf(byId)) === j(owner), j(factsOf(byId)))
const walked = await loadConversationForResume(SID, transcriptPath)
check('the file road (the transcript walk) reads the owner', walked !== null && j(factsOf(walked)) === j(owner), j(factsOf(walked)))
const lite = (await logs.fetchLogs()).find(l => l.sessionId === SID)
check('the listing lists the fixture lite: no messages yet, the session id known, the path set', lite !== undefined && logs.isLiteLog(lite) && lite.fullPath === transcriptPath, j({ lite: lite && { sessionId: lite.sessionId, messages: lite.messages.length, fullPath: lite.fullPath } }))
const full = lite ? await logs.loadFullLog(lite) : null
check(`${RED}: the picker's full load (--continue, /resume <title>, the resume picker) hands back the owner's facts`, full !== null && !logs.isLiteLog(full) && j(factsOf(full)) === j(owner), j(factsOf(full)))
const perLeaf = await logs.loadAllLogsFromSessionFile(transcriptPath)
check('the per-leaf load finds the one leaf', perLeaf.length === 1 && perLeaf[0]?.sessionId === SID, j(perLeaf.map(l => l.sessionId)))
check(`${RED}: the per-leaf load (every branch of one file) hands back the owner's facts — the worktree record and the collapse facts included`, perLeaf.length === 1 && j(factsOf(perLeaf[0])) === j(owner), j(factsOf(perLeaf[0])))
const opened = await logs.loadTranscriptFromFile(transcriptPath)
check(`${RED}: the open-this-file load hands back the owner's facts — the agent name, colour and setting, the mode and the PR link included`, j(factsOf(opened)) === j(owner), j(factsOf(opened)))

section('§3 the source — the fold\'s per-session maps are read in one function, and every reader calls it')
const logsSrc = readFileSync(join(import.meta.dir, '../../src/utils/sessionStorage/logs.ts'), 'utf8')
const recoverySrc = readFileSync(join(import.meta.dir, '../../src/utils/conversationRecovery.ts'), 'utf8')
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length
const rowMaps = ['customTitles', 'tags', 'agentNames', 'agentColors', 'agentSettings', 'modes', 'worktreeStates', 'prNumbers', 'prUrls', 'prRepositories']
const reads = Object.fromEntries(rowMaps.map(m => [m, count(logsSrc, new RegExp(`\\b${m}\\.(get|has)\\(`, 'g')) + count(recoverySrc, new RegExp(`\\b${m}\\.(get|has)\\(`, 'g'))]))
check(`${RED}: each row map is read exactly once across logs.ts and conversationRecovery.ts (worktreeStates twice: has, then get) — inside resumeFactsOf`, rowMaps.every(m => reads[m] === (m === 'worktreeStates' ? 2 : 1)), j(reads))
const body = (name: string): string => {
  const at = logsSrc.indexOf(`export async function ${name}(`)
  const next = logsSrc.indexOf('\nexport ', at + 1)
  return at === -1 ? '' : logsSrc.slice(at, next === -1 ? undefined : next)
}
check('the last-log accessor calls resumeFactsOf', body('getLastSessionLog').includes('resumeFactsOf('))
for (const name of ['loadFullLog', 'loadAllLogsFromSessionFile', 'loadTranscriptFromFile']) {
  check(`${RED}: ${name} calls resumeFactsOf`, body(name).includes('resumeFactsOf('), `resumeFactsOf( absent from ${name}'s body`)
}
check('the walk calls resumeFactsOf', recoverySrc.includes('facts: resumeFactsOf(loaded, sessionId, chain)'))
check('resumeFactsOf is defined once, in logs.ts', count(logsSrc, /export function resumeFactsOf\(/g) === 1 && !recoverySrc.includes('function resumeFactsOf('))

console.log(`\n${failures === 0 ? '✅' : '❌'} resume facts have one owner: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
