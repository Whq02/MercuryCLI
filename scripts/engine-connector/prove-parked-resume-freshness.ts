import { mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'
import { encodeSeedTranscript } from '../lib/seedTranscript.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = process.env.MERCURY_CONFIG_DIR!
const daemon = join(home, 'daemon')
const work = join(home, 'work')
process.env.MERCURY_DAEMON_DIR = daemon
mkdirSync(daemon, { recursive: true })
mkdirSync(work, { recursive: true })
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const ensure = await import('../../src/services/switchboard/ensureDaemon.js')
mock.module('../../src/services/switchboard/ensureDaemon.js', () => ({ ...ensure, ensureOwnedDaemon: async () => true }))
const control = await import('../../src/daemon/controlSocket.js')
let answer!: (reply: Record<string, unknown>) => void
let admission = new Promise<Record<string, unknown>>(resolve => { answer = resolve })
mock.module('../../src/daemon/controlSocket.js', () => ({ ...control, daemonControlRpc: async (request: { op: string }) => request.op === 'sessionAdmit' ? admission : { ok: true, outcome: 'applied' } }))
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.js')
const { sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const { focusResumedSession } = await import('../../src/services/switchboard/hopIntoSession.js')
const { statusLine } = await import('../../src/components/SwitchboardTagBar.js')
const { sessionOwnedByLiveWorker } = await import('../../src/daemon/concourseWorkers.js')
const sid = '00000000-0000-4000-8000-000000000099'
const project = getProjectDir(work)
mkdirSync(project, { recursive: true })
const transcript = join(project, `${sid}.jsonl`)
writeFileSync(transcript, encodeSeedTranscript([
  { type: 'user', uuid: '00000000-0000-4000-8000-000000000091', parentUuid: null, sessionId: sid, cwd: work, timestamp: '2026-06-19T12:00:00.000Z', message: { role: 'user', content: 'saved conversation' } },
  { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000092', parentUuid: '00000000-0000-4000-8000-000000000091', sessionId: sid, cwd: work, timestamp: '2026-06-19T12:00:01.000Z', message: { id: 'saved-reply', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'saved answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
], sid))
const seed = { schema: 1, sessionId: sid, atMs: 1000, model: { effective: 'claude-sonnet-5', setting: 'claude-sonnet-5' }, pendingModel: null, busy: false, usage: noSessionConnector().usage(), identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], workspace: { cwd: work, originalCwd: work, projectRoot: work }, queue: [] }
const factsFile = sessionFactsPath(sid)
mkdirSync(dirname(factsFile), { recursive: true })
const publish = (atMs: number, model: string): void => writeFileSync(factsFile, JSON.stringify({ ...seed, atMs, model: { effective: model, setting: model } }))
const worker = { schema: 1, runnerId: 'concourse-w1', sessionId: sid, workspaceId: work, isolation: 'shared', modelKey: 'claude-opus-4-8', spawnedAt: 900, lastLiveAt: 1000, parkedAt: 1050, parkedBy: 'operator:fixture' }
const record = (changes: Record<string, unknown> = {}): void => writeFileSync(join(daemon, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { [worker.runnerId]: { ...worker, ...changes } } }))
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const focused = () => getFocusedSessionConnector() as ReturnType<typeof getFocusedSessionConnector> & { live: () => import('../../src/services/engine-connector/seatLive.js').SessionLiveV1; status: () => import('../../src/services/engine-connector/seatLive.js').SeatStatusV1; readFacts: () => void }
const words = (): string => statusLine(focused().live(), focused().status())
const waitNextAdmission = (): void => { admission = new Promise(resolve => { answer = resolve }) }
try {
  record()
  publish(1000, 'claude-sonnet-5')
  check('the parked fixture keeps its runner id but has no live worker', sessionOwnedByLiveWorker(sid) === null)
  const first = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
  const connector = focused()
  check('the actual parked resume waits before saying ready', words().startsWith('the runner is starting'), words())
  check('the actual parked resume names the saved worker model, not its pre-park facts', connector.modelFacts().effective === worker.modelKey && connector.modelFacts().effectiveSource === 'record', JSON.stringify(connector.modelFacts()))
  connector.readFacts()
  check('rereading pre-park facts still waits', words().startsWith('the runner is starting'))
  record({ parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true })
  check('the fixture admission settles', await first.admitted)
  check('admission alone is not a runner answer', words().startsWith('the runner is starting'))
  publish(1001, worker.modelKey)
  connector.readFacts()
  check('a fresh runner answer settles the parked resume', words() === 'ready' && connector.modelFacts().effectiveSource === 'live')
  releaseFocusedSessionConnector()
  publish(1002, worker.modelKey)
  record({ modelKey: 'claude-sonnet-5', parkedAt: 1100 })
  waitNextAdmission()
  let modelNotices = 0
  const unsubscribe = connector.subscribeModel(() => { modelNotices++ })
  const second = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
  check('the same window reuses the same connector', focused() === connector)
  check('the cached connector re-arms readiness at the second resume', words().startsWith('the runner is starting'), words())
  check('a model changed while parked is the first shown on the second resume', connector.modelFacts().effective === 'claude-sonnet-5' && connector.modelFacts().effectiveSource === 'record', JSON.stringify(connector.modelFacts()))
  check('the cached model readers are notified of the retained model', modelNotices > 0)
  connector.readFacts()
  check('the old answer cannot clear the second resume fence', words().startsWith('the runner is starting'))
  record({ modelKey: 'claude-sonnet-5', parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true })
  await second.admitted
  publish(1003, 'claude-sonnet-5')
  connector.readFacts()
  check('the second resume clears on its own newer runner answer', words() === 'ready' && connector.modelFacts().effective === 'claude-sonnet-5')
  unsubscribe()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-sonnet-5', parkedAt: 1200 })
  waitNextAdmission()
  const raced = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
  record({ modelKey: 'claude-sonnet-5', parkedAt: undefined, parkedBy: undefined, pid: process.pid })
  answer({ ok: true, liveHop: true })
  await raced.admitted
  check('a confirmed live hop releases the pending resume without inventing a newer fact', words() === 'ready' && connector.modelFacts().effectiveSource === 'live', words())
  releaseFocusedSessionConnector()
  const live = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
  check('a session with a live worker is unchanged: same connector, ready, live model', await live.admitted && focused() === connector && words() === 'ready' && connector.modelFacts().effective === 'claude-sonnet-5' && connector.modelFacts().effectiveSource === 'live')
} finally {
  releaseFocusedSessionConnector()
}
console.log(`${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
