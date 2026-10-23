#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinSourceRef, waitFor } from '../lib/settingsPopupHarness.ts'

const sourceRef = pinSourceRef()
const root = join(import.meta.dir, '../..')
const turnSource = sourceRef === undefined ? readFileSync(join(root, 'src/rows/turn.ts'), 'utf8') : execFileSync('git', ['-C', root, 'show', `${sourceRef}:src/rows/turn.ts`], { encoding: 'utf8' })
const scratch = mkdtempSync(join(tmpdir(), 'rewind-safety-'))
const home = join(scratch, 'config')
const cwd = join(scratch, 'project')
const daemonDir = join(scratch, 'daemon')
for (const path of [home, cwd, daemonDir]) mkdirSync(path)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = '../daemon'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.HOME = scratch
process.env.USERPROFILE = scratch
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONCOURSE_WORKER
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(cwd)
let failures = 0
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(cwd)
bootstrap.setIsInteractive(true)
const history = await import('../../src/utils/fileHistory.ts')
const handlers = await import('../../src/cli/headless/controlHandlers.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { rewindSession } = await import('../../src/daemon/sessionSeat.ts')
const { startControlServer } = await import('../../src/daemon/controlServer.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { publishSessionFacts, readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { sessionFactsToWire, rewindOutcomeToWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { METHODS } = await import('../../src/runner/wire/methods.ts')
const { RPC_METHOD_NOT_FOUND } = await import('../../src/runner/wire/errors.ts')
const { daemonControlRpc, forgetDaemonProtoForTesting } = await import('../../src/daemon/controlSocket.ts')
type AppState = import('../../src/state/AppStateStore.ts').AppState
type Receipt = import('../../src/daemon/protocol.ts').SessionRewindOutcomeV1
type FileRequest = import('../../src/daemon/protocol.ts').SessionFileRestoreRequest
let app = getDefaultAppState()
const setAppState = (update: (prev: AppState) => AppState): void => { app = update(app) }
const updateHistory = (update: (prev: AppState['fileHistory']) => AppState['fileHistory']): void => setAppState(prev => ({ ...prev, fileHistory: update(prev.fileHistory) }))
const messages = [createUserMessage({ content: 'change the two files' }), createUserMessage({ content: 'next task' })]
const first = messages[0]!.uuid
const alpha = join(cwd, 'alpha.txt')
const beta = join(cwd, 'beta.txt')
writeFileSync(alpha, 'alpha old\n')
writeFileSync(beta, 'beta old\n')
await history.fileHistoryMakeSnapshot(updateHistory, first)
await history.fileHistoryTrackEdit(updateHistory, alpha, first)
await history.fileHistoryTrackEdit(updateHistory, beta, first)
writeFileSync(alpha, 'alpha newer\n')
writeFileSync(beta, 'beta newer\n')
await history.fileHistoryMakeSnapshot(updateHistory, messages[1]!.uuid)
const oracle = new Map<string, { content: string; timestamp: number; offset: undefined; limit: undefined }>()
const remember = (path: string): void => { oracle.set(path, { content: readFileSync(path, 'utf8'), timestamp: Math.floor(statSync(path).mtimeMs), offset: undefined, limit: undefined }) }
remember(alpha)
remember(beta)
const ctx = { messages, getAppState: () => app, setAppState, drift: oracle, turnActive: false }
const sid = String(bootstrap.getSessionId())
const runnerId = 'concourse-w1'
updateConcourseWorkers(workers => {
  workers[runnerId] = { schema: 1, runnerId, sessionId: sid, workspaceId: cwd, isolation: 'shared', modelKey: 'fixture', effort: 'max', spawnedAt: Date.now(), lastLiveAt: Date.now() } as never
}, daemonDir)
const baseFacts = { schema: 1 as const, sessionId: sid, atMs: Date.now(), model: { effective: 'fixture', setting: null }, usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default' as const, workspace: { cwd, originalCwd: cwd, projectRoot: cwd, instructionRoots: [] }, queue: [], pendingModel: null, busy: false }
const facts = () => ({ ...baseFacts, fileCheckpoints: { capture: true, restorable: app.fileHistory.snapshots.map(s => s.messageId), files: [...app.fileHistory.trackedFiles], ...(app.fileHistory.rewindUndo === undefined ? {} : { undo: app.fileHistory.rewindUndo.messageId }) } })
const stand = standInRunner({ autoAnswer: { 'session/facts': () => sessionFactsToWire(facts() as never) } })
const seen: string[] = []
stand.runner.onRequest('session/rewind', async params => { seen.push('session/rewind'); return rewindOutcomeToWire(await handlers.handleRewindSession(params, ctx)) as never })
const supportsFiles = 'session/file_restore' in METHODS
if (supportsFiles) stand.runner.onRequest('session/file_restore', async params => { seen.push('session/file_restore'); return rewindOutcomeToWire(await handlers.handleFileRestoreSession(params, ctx)) as never })
const roster = stand.roster({ list: () => [{ short: runnerId, busy: false }] })
const key = 'f'.repeat(64)
writeFileSync(join(daemonDir, 'control.key'), key)
const server = await startControlServer({
  roster: { list: () => [] }, breaker: {}, dir: daemonDir, startedAt: Date.now(), maxInflight: 1, controlKey: key, isReady: () => true,
  onShutdown: () => ({ reaped: 0, workers: [] }),
  sessionRewind: (req: { sessionId: string; mode: 'code' | 'both' | 'conversation'; userMessageId: string; dryRun?: boolean }) => rewindSession(req.sessionId, req, roster as never, daemonDir),
  sessionFileRestore: (req: FileRequest & { sessionId: string }) => rewindSession(req.sessionId, { mode: 'code', userMessageId: req.userMessageId }, roster as never, daemonDir, { fileRestore: req }),
} as never)
const connector = async (): Promise<InstanceType<typeof DaemonSessionConnector>> => {
  const next = facts()
  publishSessionFacts(next as never, daemonDir)
  await waitFor(() => JSON.stringify(readSessionFacts(sid, daemonDir)?.fileCheckpoints) === JSON.stringify(next.fileCheckpoints), 3000)
  return new DaemonSessionConnector({ sessionId: sid, runnerId, title: 'fixture', projectLabel: 'fixture', workspaceId: cwd, home })
}
const restore = async (files?: { filePath?: string; undo?: boolean; userMessageId?: string }): Promise<Receipt> => (await connector()).rewind({ userMessageId: first, mode: 'code', ...files })
try {
  const dry = await (await connector()).rewind({ userMessageId: first, mode: 'code', dryRun: true })
  check('dry run names both files without an undo snapshot', dry.code?.filesChanged.length === 2 && app.fileHistory.rewindUndo === undefined && readFileSync(alpha, 'utf8') === 'alpha newer\n', dry)
  const rewound = await restore()
  check('ordinary rewind restores both saved files over the existing method', rewound.outcome === 'applied' && readFileSync(alpha, 'utf8') === 'alpha old\n' && readFileSync(beta, 'utf8') === 'beta old\n', rewound)
  const undo = (await connector()).checkpointFacts().undo
  check('the runner publishes a pre-rewind checkpoint', typeof undo === 'string', { undo })
  const undone = await restore({ undo: true, userMessageId: undo ?? first })
  check('rewind then undo restores both newer byte strings', undone.outcome === 'applied' && readFileSync(alpha, 'utf8') === 'alpha newer\n' && readFileSync(beta, 'utf8') === 'beta newer\n', undone)
  check('undo consumes its checkpoint and leaves conversation unchanged', app.fileHistory.rewindUndo === undefined && messages.length === 2)

  writeFileSync(alpha, 'alpha newer\n'); writeFileSync(beta, 'beta newer\n'); remember(alpha); remember(beta)
  const betaBefore = statSync(beta)
  const single = await restore({ filePath: 'alpha.txt' })
  check('single-file restore changes alpha only (beta bytes and mtime survive)', single.outcome === 'applied' && single.code?.filesChanged.join() === 'alpha.txt' && readFileSync(alpha, 'utf8') === 'alpha old\n' && readFileSync(beta, 'utf8') === 'beta newer\n' && statSync(beta).mtimeMs === betaBefore.mtimeMs, single)
  const undoSingle = app.fileHistory.rewindUndo?.messageId
  writeFileSync(alpha, 'hand edit after rewind\n')
  const touched = new Date(Date.now() + 5000); utimesSync(alpha, touched, touched)
  const undoDrift = await restore({ undo: true, userMessageId: undoSingle ?? first })
  check('undo also refuses hand edits after the rewind', undoDrift.refusal === 'drift' && readFileSync(alpha, 'utf8') === 'hand edit after rewind\n', undoDrift)
  writeFileSync(alpha, 'alpha old\n'); remember(alpha)
  if (undoSingle) await restore({ undo: true, userMessageId: undoSingle })
  writeFileSync(beta, 'hand edited beta\n')
  const future = new Date(Date.now() + 5000); utimesSync(beta, future, future)
  const safe = await restore({ filePath: 'alpha.txt' })
  check('another file\'s hand edit cannot block or be touched by single-file restore', safe.outcome !== 'refused' && readFileSync(beta, 'utf8') === 'hand edited beta\n', safe)
  const drift = await restore({ filePath: 'beta.txt' })
  check('selected-file drift refuses by name', drift.refusal === 'drift' && drift.detail?.includes('beta.txt') === true && readFileSync(beta, 'utf8') === 'hand edited beta\n', drift)
  const expired = app.fileHistory.rewindUndo?.messageId ?? first
  await history.fileHistoryMakeSnapshot(updateHistory, randomUUID())
  const afterPrompt = await restore({ undo: true, userMessageId: expired })
  check('the next prompt expires undo; the stale id cannot restore files', afterPrompt.outcome === 'refused' && afterPrompt.refusal === 'no-checkpoint', afterPrompt)
  check('both additive operations reached the runner peer, not a screen-side restore', seen.filter(method => method === 'session/file_restore').length >= 4, seen)

  writeFileSync(alpha, 'alpha next\n'); remember(alpha)
  await restore({ filePath: 'alpha.txt' })
  const offUndo = app.fileHistory.rewindUndo?.messageId ?? first
  const beforeOff = app.fileHistory.snapshots.length
  saveGlobalConfig(config => ({ ...config, fileCheckpointingEnabled: false }))
  await history.fileHistoryMakeSnapshot(updateHistory, randomUUID())
  check('every accepted model prompt reaches undo expiry even with capture off', turnSource.includes('if (!persistenceDisabled) {\n      const snapshots: Promise<void>[] = []') && turnSource.includes('snapshots.push(fileHistoryMakeSnapshot('))
  check('a prompt with capture off creates no snapshot', app.fileHistory.snapshots.length === beforeOff && !history.fileHistoryEnabled())
  saveGlobalConfig(config => ({ ...config, fileCheckpointingEnabled: true }))
  const offThenOn = await restore({ undo: true, userMessageId: offUndo })
  check('off → prompt → on cannot revive the preceding undo', offThenOn.refusal === 'no-checkpoint' && app.fileHistory.rewindUndo === undefined, offThenOn)

  const malformed = await daemonControlRpc({ op: 'sessionFileRestore', sessionId: sid, by: 'operator', userMessageId: first, action: 'restore' } as never)
  check('a single-file request without a file cannot degrade to whole-tree restore', malformed.ok === false, malformed)
  if (supportsFiles) {
    const { RpcError } = await import('../../src/runner/wire/errors.ts')
    stand.runner.onRequest('session/file_restore', () => { throw new RpcError(RPC_METHOD_NOT_FOUND, 'unknown method session/file_restore') })
    const before = readFileSync(beta)
    const older = await restore({ filePath: 'beta.txt' })
    check('one-build-older runner refuses the new method without writing', older.refusal === 'runner-older' && readFileSync(beta).equals(before), older)
    const oldDry = await (await connector()).rewind({ userMessageId: first, mode: 'code', dryRun: true })
    check('the old rewind method remains callable after an unsupported new method', oldDry.refusal === 'drift', oldDry)
  } else check('the additive runner method exists', false)

  const cleanup = await import('../../src/utils/cleanup.ts')
  const store = join(home, 'file-history')
  await flushSessionStorage()
  rmSync(store, { recursive: true, force: true })
  const mb = 1024 * 1024
  const makeStore = (name: string, bytes: number, age: number): string => {
    const dir = join(store, name); mkdirSync(dir, { recursive: true })
    const file = join(dir, 'checkpoint@v1'); const fd = openSync(file, 'w'); ftruncateSync(fd, bytes); closeSync(fd)
    const time = new Date(Date.now() - age); utimesSync(file, time, time); utimesSync(dir, time, time)
    return dir
  }
  const newest = makeStore('a-newest', 200 * mb, 1000)
  const oldest = makeStore('z-oldest', 200 * mb, 3000)
  const middle = makeStore('m-middle', 100 * mb, 2000)
  const sweep = () => cleanup.cleanupOldMessageFilesInBackground()
  const atLimit = await sweep()
  check('exactly 500 MB is retained', atLimit.errors === 0 && existsSync(oldest) && existsSync(middle) && existsSync(newest), atLimit)
  const extra = makeStore('b-latest', 1, 0)
  const over = await sweep()
  check('one byte over 500 MB prunes oldest first, not directory-name order', over.errors === 0 && !existsSync(oldest) && existsSync(middle) && existsSync(newest) && existsSync(extra), over)
  const { runHealthReport } = await import('../../src/utils/healthReport.ts')
  const certificate = await runHealthReport()
  const row = certificate.sections.flatMap(section => section.checks).find(check => check.id === 'lifecycle-collection')
  check('/health State cleanup reports actual usage and the 500 MB cap', row?.evidence.includes('file history 300.0 MB / 500 MB') === true, row?.evidence)
} finally {
  await server.close()
  stand.close()
  forgetDaemonProtoForTesting()
  await flushSessionStorage()
  process.chdir(tmpdir())
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`Rewind safety net: ${failures === 0 ? 'PASS' : `${failures} FAILURES`}`)
process.exit(failures === 0 ? 0 : 1)
