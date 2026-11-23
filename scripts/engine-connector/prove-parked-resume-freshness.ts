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
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const ensure = await import('../../src/daemon/switchboard/ensureDaemon.js')
mock.module('../../src/daemon/switchboard/ensureDaemon.js', () => ({ ...ensure, ensureOwnedDaemon: async () => true }))
const control = await import('../../src/daemon/control/controlSocket.js')
let answer!: (reply: Record<string, unknown>) => void
let admission = new Promise<Record<string, unknown>>(resolve => { answer = resolve })
const asked: Array<Record<string, unknown>> = []
let pingAnswers = true
let scripted: (request: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>> | undefined = () => undefined
let unreachableAt = 0
mock.module('../../src/daemon/control/controlSocket.js', () => ({ ...control, daemonLastUnreachableAt: () => unreachableAt, daemonControlRpc: async (request: { op: string }) => {
  asked.push(request as Record<string, unknown>)
  const reply = request.op === 'ping' && !pingAnswers ? { ok: false, code: 'ENOCONN', error: 'daemon unreachable (ENOENT)' } : await (scripted(request as Record<string, unknown>) ?? (request.op === 'sessionAdmit' ? admission : { ok: true, outcome: 'applied' }))
  if (reply.code === 'ENOCONN') unreachableAt = Date.now()
  return reply
} }))
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.js')
const { sessionFactsPath } = await import('../../src/engine/connector/seatProjections.js')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { getFocusedSessionConnector, releaseFocusedSessionConnector, setFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { daemonSessionConnectorFor } = await import('../../src/engine/connector/daemonConnector.js')
const { focusResumedSession } = await import('../../src/daemon/switchboard/hopIntoSession.js')
const { statusLine } = await import('../../src/screen/chat/SwitchboardTagBar.js')
const { sessionOwnedByLiveWorker } = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
const { subscribeSeatReceipts } = await import('../../src/models/facts/seatReceipts.js')
const receipts: string[] = []
subscribeSeatReceipts(receipt => { receipts.push(receipt.text) })
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
const publish = (atMs: number, model: string, runner?: Record<string, unknown>): void => writeFileSync(factsFile, JSON.stringify({ ...seed, atMs, model: { effective: model, setting: model }, ...(runner !== undefined ? { runner } : {}) }))
const worker = { schema: 1, runnerId: 'concourse-w1', sessionId: sid, workspaceId: work, isolation: 'shared', modelKey: 'claude-opus-4-8', spawnedAt: 900, lastLiveAt: 1000, parkedAt: 1050, parkedBy: 'operator:fixture' }
const record = (changes: Record<string, unknown> = {}): void => writeFileSync(join(daemon, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { [worker.runnerId]: { ...worker, ...changes } } }))
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${ok ? '' : ' — to change: the resume path is focusResumedSession in src/daemon/switchboard/hopIntoSession.ts and the admission wait of DaemonSessionConnector (AdmissionPart in src/engine/connector/daemon/admission.ts); the row words come from statusLine in src/screen/chat/SwitchboardTagBar.tsx; the fixture records (concourse-workers.json, the session facts file, the scripted daemonControlRpc) are at the top of this file'}`)
}
const focused = () => getFocusedSessionConnector() as ReturnType<typeof getFocusedSessionConnector> & { live: () => import('../../src/engine/connector/seatLive.js').SessionLiveV1; status: () => import('../../src/engine/connector/seatLive.js').SeatStatusV1; readFacts: () => void }
const words = (): string => statusLine(focused().live(), focused().status())
const waitNextAdmission = (): void => { admission = new Promise(resolve => { answer = resolve }) }
const resumed = async (): Promise<Awaited<ReturnType<typeof focusResumedSession>>> => {
  const outcome = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
  for (let waited = 0; typeof (getFocusedSessionConnector() as { live?: unknown }).live !== 'function' && waited < 5_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  return outcome
}
try {
  record()
  publish(1000, 'claude-sonnet-5')
  check('the parked fixture keeps its runner id but has no live worker', sessionOwnedByLiveWorker(sid) === null)
  const first = await resumed()
  const connector = focused()
  check('the actual parked resume waits before saying ready', words().startsWith('the runner is starting'), words())
  check('the actual parked resume names the saved worker model, not its pre-park facts', connector.modelFacts().effective === worker.modelKey && connector.modelFacts().effectiveSource === 'record', JSON.stringify(connector.modelFacts()))
  connector.readFacts()
  check('rereading pre-park facts still waits', words().startsWith('the runner is starting'))
  record({ parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true })
  check('the fixture admission settles', await first.admitted)
  check('admission alone is not a runner answer', words().startsWith('the runner is starting'))
  const realNow = Date.now
  const opened = connector.status().runner?.sinceMs ?? 0
  try {
    Date.now = () => opened + 3_000
    check('three seconds into the wait the row counts three', words() === 'the runner is starting · 3s', words())
    publish(1001, worker.modelKey, { state: 'starting', sinceMs: opened + 2_900, respawns: 0, maxRespawns: 3 })
    connector.readFacts()
    check("the runner's own starting fact takes the row over and the count does not run backwards", words() === 'the runner is starting · 3s', words())
    Date.now = () => opened + 4_000
    check('the count goes on from the start the row already showed', words() === 'the runner is starting · 4s', words())
    publish(1001, worker.modelKey)
    connector.readFacts()
    check('a fresh runner answer settles the parked resume', words() === 'ready' && connector.modelFacts().effectiveSource === 'live')
    Date.now = () => opened + 600_000
    publish(1001, worker.modelKey, { state: 'starting', sinceMs: opened + 598_000, respawns: 1, maxRespawns: 3 })
    connector.readFacts()
    check("a later restart counts from its own start, never from the resume's", words() === 'the runner is restarting (1/3) · 2s', words())
    publish(1001, worker.modelKey, { state: 'starting', sinceMs: opened + 599_000, respawns: 0, maxRespawns: 3 })
    connector.readFacts()
    check('a later first start with no wait before it counts from its own start too', words() === 'the runner is starting · 1s', words())
  } finally {
    Date.now = realNow
  }
  publish(1001, worker.modelKey)
  connector.readFacts()
  releaseFocusedSessionConnector()
  publish(1002, worker.modelKey)
  record({ modelKey: 'claude-sonnet-5', parkedAt: 1100 })
  waitNextAdmission()
  let modelNotices = 0
  const unsubscribe = connector.subscribeModel(() => { modelNotices++ })
  const second = await resumed()
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
  const raced = await resumed()
  const hopOpened = connector.status().runner?.sinceMs ?? 0
  record({ modelKey: 'claude-sonnet-5', parkedAt: undefined, parkedBy: undefined, pid: process.pid })
  answer({ ok: true, liveHop: true })
  await raced.admitted
  check('a confirmed live hop releases the pending resume without inventing a newer fact', words() === 'ready' && connector.modelFacts().effectiveSource === 'live', words())
  const hopNow = Date.now
  try {
    Date.now = () => hopOpened + 2_000
    publish(1004, 'claude-sonnet-5', { state: 'starting', sinceMs: hopOpened + 1_900, respawns: 0, maxRespawns: 3 })
    connector.readFacts()
    check("after a live hop a runner still starting keeps the clock the row showed while it waited", words() === 'the runner is starting · 2s', words())
  } finally {
    Date.now = hopNow
  }
  publish(1004, 'claude-sonnet-5')
  connector.readFacts()
  releaseFocusedSessionConnector()
  const live = await resumed()
  check('a session with a live worker is unchanged: same connector, ready, live model', await live.admitted && focused() === connector && words() === 'ready' && connector.modelFacts().effective === 'claude-sonnet-5' && connector.modelFacts().effectiveSource === 'live')
  const dialled = (request: Record<string, unknown>): boolean => request.op === 'sessionControl' && (request.action === 'set-model' || request.action === 'set-effort')
  const askedWords = (): string => JSON.stringify(asked.map(request => [request.op, request.action, request.model, request.effort]))
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-sonnet-5', effort: 'high', parkedAt: 1300 })
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1005, effort: 'high', effortSent: 'high' }))
  waitNextAdmission()
  const relaunched = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-opus-5', effort: 'max' })
  record({ modelKey: 'claude-opus-5', effort: 'max', parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true, modelId: 'claude-opus-5', effort: 'max' })
  await relaunched.admitted
  check("while the runner is awaited the effort shown is the record's, not the one the life before left in the facts", words().startsWith('the runner is starting') && connector.modelFacts().effective === 'claude-opus-5' && connector.modelFacts().effort === 'max' && connector.modelFacts().effortSent === undefined, `${words()} ${JSON.stringify(connector.modelFacts())}`)
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1006, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, effort: 'max', effortSent: 'max' }))
  connector.readFacts()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-opus-5', effort: 'max', parkedAt: 1400, pid: process.pid })
  waitNextAdmission()
  asked.length = 0
  const launched = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-sonnet-5', effort: 'high' })
  await new Promise(resolve => setTimeout(resolve, 50))
  const admitted = asked.find(request => request.op === 'sessionAdmit')
  check("a parked session whose runner's process still stands is resumed through the admission, and the admission carries the launch's model and effort", sessionOwnedByLiveWorker(sid) !== null && admitted?.model === 'claude-sonnet-5' && admitted?.effort === 'high', askedWords())
  check('a parked session is not dialled as a live one', !asked.some(dialled), askedWords())
  record({ modelKey: 'claude-sonnet-5', effort: 'high', parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true, modelId: 'claude-sonnet-5', effort: 'high' })
  await launched.admitted
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1007, effort: 'high', effortSent: 'high' }))
  connector.readFacts()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-sonnet-5', effort: 'high', parkedAt: undefined, parkedBy: undefined, pid: process.pid })
  pingAnswers = false
  waitNextAdmission()
  asked.length = 0
  const orphaned = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-opus-5', effort: 'max' })
  await new Promise(resolve => setTimeout(resolve, 50))
  const readmitted = asked.find(request => request.op === 'sessionAdmit')
  check("a session whose runner's process stands under a daemon that does not answer is resumed through the admission with the launch's words, not dialled", sessionOwnedByLiveWorker(sid) !== null && readmitted?.model === 'claude-opus-5' && readmitted?.effort === 'max' && !asked.some(dialled), askedWords())
  record({ modelKey: 'claude-opus-5', effort: 'max', parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true, modelId: 'claude-opus-5', effort: 'max' })
  await orphaned.admitted
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1008, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, effort: 'max', effortSent: 'max' }))
  connector.readFacts()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-opus-5', effort: 'max', parkedAt: undefined, parkedBy: undefined, pid: process.pid })
  waitNextAdmission()
  asked.length = 0
  const held = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-sonnet-5', effort: 'high' })
  answer({ ok: true, liveHop: true, modelId: 'claude-opus-5', effort: 'max' })
  await held.admitted
  await new Promise(resolve => setTimeout(resolve, 50))
  pingAnswers = true
  const askedAt = (op: string, action?: string): number => asked.findIndex(request => request.op === op && (action === undefined || request.action === action))
  check("an admission the daemon answers as a live hop is followed by the launch's dials, asked of the daemon that answered", askedAt('sessionAdmit') >= 0 && askedAt('sessionControl', 'set-model') > askedAt('sessionAdmit') && asked[askedAt('sessionControl', 'set-model')]?.model === 'claude-sonnet-5' && asked[askedAt('sessionControl', 'set-effort')]?.effort === 'high', askedWords())
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1009, model: { effective: 'claude-opus-5', setting: 'claude-opus-5' }, effort: 'max', effortSent: 'max' }))
  connector.readFacts()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-opus-5', effort: 'max', parkedAt: 1500, pid: process.pid })
  let oldRunnerStands = true
  scripted = request =>
    !oldRunnerStands ? undefined
      : request.op === 'sessionAdmit' ? { ok: true, liveHop: true, modelId: 'claude-opus-5', effort: 'max' }
        : dialled(request) ? { ok: true, outcome: 'refused', detail: "the runner's door is closed while its process (pid 1) still stands — retry in a moment" }
          : undefined
  waitNextAdmission()
  asked.length = 0
  receipts.length = 0
  const leaving = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-sonnet-5', effort: 'high' })
  await new Promise(resolve => setTimeout(resolve, 300))
  oldRunnerStands = false
  record({ modelKey: 'claude-opus-5', effort: 'max', parkedAt: 1500 })
  for (let waited = 0; asked.filter(request => request.op === 'sessionAdmit').length < 2 && waited < 3000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20))
  record({ modelKey: 'claude-sonnet-5', effort: 'high', parkedAt: undefined, parkedBy: undefined })
  answer({ ok: true, modelId: 'claude-sonnet-5', effort: 'high' })
  await leaving.admitted
  await new Promise(resolve => setTimeout(resolve, 50))
  scripted = () => undefined
  const admissions = asked.filter(request => request.op === 'sessionAdmit')
  check("a resume the daemon answers as a live hop while the parked session's old runner is still leaving waits for that runner to go and is admitted again with the launch's words: nothing is dialled, nothing is refused", admissions.length >= 2 && admissions.every(request => request.model === 'claude-sonnet-5' && request.effort === 'high') && !asked.some(dialled) && !receipts.some(text => text.includes('was refused') || text.includes('still holds this session')), `${askedWords()} ${JSON.stringify(receipts)}`)
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1010, effort: 'high', effortSent: 'high' }))
  connector.readFacts()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-sonnet-5', effort: 'high', parkedAt: undefined, parkedBy: undefined, pid: process.pid })
  let dialSeen = false
  scripted = request => {
    if (request.op === 'ping') return dialSeen ? { ok: false, code: 'ETIMEOUT', error: 'daemon did not answer within 500ms (ETIMEOUT)' } : undefined
    if (request.action !== 'set-model') return undefined
    dialSeen = true
    return { ok: true, outcome: 'refused', detail: 'model refused (no-credential)' }
  }
  waitNextAdmission()
  asked.length = 0
  receipts.length = 0
  const refusedLive = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-opus-5', effort: 'max' })
  await refusedLive.admitted
  await new Promise(resolve => setTimeout(resolve, 100))
  scripted = () => undefined
  check('a dial the daemon refuses on a live session is shown as refused and the other dial is still made, though the daemon is slow to answer a ping: no resume is asked', receipts.some(text => text.includes('--model Opus 5 was refused') && text.includes('model refused (no-credential)')) && asked.some(request => request.action === 'set-effort' && request.effort === 'max') && !asked.some(request => request.op === 'sessionAdmit'), `${askedWords()} ${JSON.stringify(receipts)}`)
  answer({ ok: true, liveHop: true })
  writeFileSync(factsFile, JSON.stringify({ ...seed, atMs: 1011, effort: 'high', effortSent: 'high' }))
  connector.readFacts()
  releaseFocusedSessionConnector()
  record({ modelKey: 'claude-sonnet-5', effort: 'high', parkedAt: undefined, parkedBy: undefined, pid: process.pid })
  let daemonGoes!: () => void
  const dialHeld = new Promise<Record<string, unknown>>(resolve => { daemonGoes = () => resolve({ ok: false, code: 'ENOCONN', error: 'daemon closed without a reply (ENOCONN)' }) })
  scripted = request => (request.action === 'set-model' ? dialHeld : undefined)
  waitNextAdmission()
  asked.length = 0
  const moved = await focusResumedSession(sid, transcript, { firstPaintMs: 10, model: 'claude-opus-5', effort: 'max' })
  await moved.admitted
  for (let waited = 0; !asked.some(request => request.action === 'set-model') && waited < 3000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20))
  const elsewhere = daemonSessionConnectorFor({ sessionId: '00000000-0000-4000-8000-000000000098', runnerId: 'concourse-w9', title: 'another session', projectLabel: 'work', workspaceId: work, home: project })
  setFocusedSessionConnector(elsewhere)
  daemonGoes()
  await new Promise(resolve => setTimeout(resolve, 150))
  scripted = () => undefined
  check('a launch whose dial loses the daemon after the user has moved to another session leaves the focus where the user put it and resumes nothing', getFocusedSessionConnector() === elsewhere && !asked.some(request => request.op === 'sessionAdmit'), `focused ${getFocusedSessionConnector().sessionId()} ${askedWords()}`)
  answer({ ok: true, liveHop: true })
  releaseFocusedSessionConnector()
  const recordless = '00000000-0000-4000-8000-000000000097'
  const recordlessTranscript = join(project, `${recordless}.jsonl`)
  writeFileSync(recordlessTranscript, encodeSeedTranscript([
    { type: 'user', uuid: '00000000-0000-4000-8000-000000000093', parentUuid: null, sessionId: recordless, cwd: work, timestamp: '2026-06-19T12:00:00.000Z', message: { role: 'user', content: 'a session no record names' } },
  ], recordless))
  writeFileSync(sessionFactsPath(recordless), JSON.stringify({ ...seed, sessionId: recordless, atMs: 1012, effort: 'high', effortSent: 'high' }))
  waitNextAdmission()
  const bare = await focusResumedSession(recordless, recordlessTranscript, { firstPaintMs: 10 })
  for (let waited = 0; focused().sessionId() !== recordless && waited < 5_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5))
  check('while the runner is awaited no effort is shown as sent, also when no record holds one', focused().sessionId() === recordless && words().startsWith('the runner is starting') && focused().modelFacts().effortSent === undefined, `${focused().sessionId()} ${words()} ${JSON.stringify(focused().modelFacts())}`)
  answer({ ok: false, error: 'the fixture ends here' })
  await bare.admitted
} finally {
  releaseFocusedSessionConnector()
}
console.log(`${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
