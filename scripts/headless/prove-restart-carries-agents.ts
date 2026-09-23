#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, makeTally, queueJournal, removeWorld, sleep, transcriptFiles, user, type Frame, type QueueJournalRow } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-restart-carries-agents')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
console.log(' red on the base: every check of the crash leg and the stop leg after the seeding (the base writes "nothing it started will be delivered" for both agents, relaunches nothing, re-queues nothing, writes no row)')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'restart-carries-agents-')))
const crashHome = join(root, 'crash-home')
const stopHome = join(root, 'stop-home')
const plainHome = join(root, 'plain-home')
const cwd = join(root, 'work')
seedScratchHome(crashHome, cwd)

const FIRST_ASK = 'restart probe: launch the two helpers'
const QUESTION = 'restart probe: what landed while the runner was down'
const LINE = 'restart probe: the line typed during the turn that died with the runner'
const LINE_UUID = '00000000-0000-4000-8000-00000000d1e5'
const DONE_PROMPT = 'restart probe child: finish before the crash'
const LIVE_PROMPT = 'restart probe child: still working at the crash'
const DONE_DESCRIPTION = 'finished before the crash'
const LIVE_DESCRIPTION = 'working at the crash'
const DONE_REPLY = 'the finished child left its receipt'
const RELAUNCH_REPLY = 'the relaunched child finished its work'
const PARENT_DONE = 'both helpers are launched'
const CRASH_ROW = 'runner restarted after a crash: 1 background agents relaunched, 1 delivered from their receipts, 0 stopped'
const STOP_ROW = 'runner restarted after a stop: 1 background agents relaunched, 1 delivered from their receipts, 0 stopped'
const HANG_MS = 600_000

type Block = { type?: string; id?: string; name?: string; input?: { description?: unknown }; tool_use_id?: string; content?: unknown; text?: string }
type Launch = { toolUseId: string; agentId: string }
const blocksOf = (f: Frame): Block[] => {
  const content = (f.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const resultTextOf = (b: Block): string => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map(x => x.text ?? '').join('') : '')
const launchOf = (frames: Frame[], description: string): Launch | null => {
  const blocks = frames.flatMap(blocksOf)
  const use = blocks.find(b => b.type === 'tool_use' && b.name === 'Agent' && b.input?.description === description)
  if (use?.id === undefined) return null
  const result = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === use.id)
  const agentId = result === undefined ? undefined : /agentId: (\S+)/.exec(resultTextOf(result))?.[1]
  return agentId === undefined ? null : { toolUseId: use.id, agentId }
}
const textsOf = (req: ScriptedRequest): string => req.allTexts.join('\n')
const isDone = (req: ScriptedRequest): boolean => textsOf(req).includes(DONE_PROMPT)
const isLive = (req: ScriptedRequest): boolean => textsOf(req).includes(LIVE_PROMPT)
const isLine = (req: ScriptedRequest): boolean => !isDone(req) && !isLive(req) && req.ask.includes(LINE)
const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const waitUntil = async (test: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (test()) return true
    await sleep(100)
  }
  return test()
}
const mainTranscripts = (home: string): string[] => transcriptFiles(join(home, 'projects')).filter(p => !/[\\/]subagents[\\/]/.test(p))
const enqueuedAfter = (home: string, from: number): QueueJournalRow[] => queueJournal(join(home, 'projects')).slice(from).filter(r => r.operation === 'enqueue')
const noticesFor = (rows: QueueJournalRow[], agentId: string, status: string): QueueJournalRow[] =>
  rows.filter(r => r.content.includes(`<task-id>${agentId}</task-id>`) && r.content.includes(`<status>${status}</status>`))
const inputRowsWith = (file: string, words: string): Array<Record<string, unknown>> =>
  readText(file)
    .split('\n')
    .flatMap(line => {
      try {
        const rec = JSON.parse(line) as { payload?: { kind?: string }; annotations?: { uuid?: string }; recordId?: string }
        return rec.payload?.kind === 'input' && line.includes(words) ? [rec as Record<string, unknown>] : []
      } catch {
        return []
      }
    })

let stage: 'launch' | 'restart' = 'launch'
const script: Script = req => {
  if (isLive(req)) return [{ type: 'text', text: RELAUNCH_REPLY }]
  if (isDone(req)) return [{ type: 'text', text: DONE_REPLY }]
  if (isLine(req)) return [{ type: 'text', text: 'the line was read' }]
  if (req.ask.includes(FIRST_ASK)) {
    if (req.step > 0) return [{ type: 'text', text: PARENT_DONE }]
    return [
      { type: 'tool_use', name: 'Agent', input: { description: DONE_DESCRIPTION, prompt: DONE_PROMPT, subagent_type: 'mercury-general', run_in_background: true } },
      { type: 'tool_use', name: 'Agent', input: { description: LIVE_DESCRIPTION, prompt: LIVE_PROMPT, subagent_type: 'mercury-general', run_in_background: true } },
    ]
  }
  return [{ type: 'text', text: 'noted' }]
}
const fixture = await startScriptedFixture(script, { answerDelayMs: req => (stage === 'launch' && (isDone(req) || isLive(req)) ? HANG_MS : 0) })
const port = Number(new URL(fixture.base).port)
const envFor = (home: string, reason?: string): NodeJS.ProcessEnv => {
  const env = childEnv(home, port)
  delete env.MERCURY_RUNNER_RESTART_REASON
  delete env.MERCURY_CONCOURSE_WORKER
  return reason === undefined ? env : { ...env, MERCURY_RUNNER_RESTART_REASON: reason, MERCURY_CONCOURSE_WORKER: '1' }
}

tally.section('the first runner launches two background agents, then dies with both still running')
const first = bootRunner({ cwd, env: envFor(crashHome) })
first.send(user(FIRST_ASK, randomUUID()))
const bothOnWire = await waitUntil(() => fixture.requests.some(isDone) && fixture.requests.some(isLive), bound(90_000))
tally.check("both children's first requests reached the wire", bothOnWire, `${fixture.requests.length} requests`)
const sessionFileOf = (): string | undefined => mainTranscripts(crashHome).find(p => readText(p).includes(FIRST_ASK))
const recorded = await waitUntil(() => {
  const file = sessionFileOf()
  if (file === undefined) return false
  const text = readText(file)
  return text.includes(PARENT_DONE) && text.split('Agent launched in the background.').length >= 3
}, bound(60_000))
tally.check('the session transcript holds both launch receipts and the reply after them', recorded)
const childTranscripts = (): string[] => transcriptFiles(join(crashHome, 'projects')).filter(p => /[\\/]subagents[\\/]/.test(p))
const liveOnDisk = await waitUntil(() => childTranscripts().some(p => readText(p).includes(LIVE_PROMPT)), bound(30_000))
tally.check("the running child's own transcript is on disk", liveOnDisk)
const done = launchOf(first.frames, DONE_DESCRIPTION)
const live = launchOf(first.frames, LIVE_DESCRIPTION)
tally.check('both launches carry their agent ids', done !== null && live !== null, JSON.stringify({ done, live }))
first.kill()
await first.exited
const sessionFile = sessionFileOf()
if (done === null || live === null || sessionFile === undefined) {
  tally.check('the first world is complete enough to restart', false, JSON.stringify({ done, live, sessionFile }))
  await Promise.race([fixture.close(), sleep(bound(5_000))])
  await removeWorld(root)
  tally.finish()
}

tally.section('the world is seeded as the box left it: the finished agent\'s completion notice, the dying runner\'s own stop notice for the running one, and the operator\'s line, all enqueued and never read by a turn')
const heldDone = [
  '<task-notification>',
  `<task-id>${done!.agentId}</task-id>`,
  `<tool-use-id>${done!.toolUseId}</tool-use-id>`,
  `<output-file>${join(root, 'tasks', `${done!.agentId}.output`)}</output-file>`,
  '<status>completed</status>',
  `<summary>Agent "${DONE_DESCRIPTION}" completed</summary>`,
  `<result>${DONE_REPLY}</result>`,
  '<usage><total_tokens>48</total_tokens><tool_uses>0</tool_uses><duration_ms>1200</duration_ms></usage>',
  '</task-notification>',
].join('\n')
const heldLiveStop = [
  '<task-notification>',
  `<task-id>${live!.agentId}</task-id>`,
  `<tool-use-id>${live!.toolUseId}</tool-use-id>`,
  `<output-file>${join(root, 'tasks', `${live!.agentId}.output`)}</output-file>`,
  '<status>killed</status>',
  `<summary>Agent "${LIVE_DESCRIPTION}" was stopped — 2 file writes landed: ${join(cwd, 'a.ts')}, ${join(cwd, 'b.ts')} — its work is kept; resume it from the crew view (r on its row) or by SendMessage to its id</summary>`,
  '</task-notification>',
].join('\n')
const ordinals = readText(sessionFile!)
  .split('\n')
  .map(line => {
    try {
      return Number((JSON.parse(line) as { creationOrdinal?: unknown }).creationOrdinal)
    } catch {
      return 0
    }
  })
  .filter(n => Number.isFinite(n))
let nextOrdinal = Math.max(0, ...ordinals) + 1
const sessionId = basename(sessionFile!, '.jsonl')
const at = new Date().toISOString()
const queueRecord = (operation: 'enqueue' | 'dequeue', fields: Record<string, unknown> = {}): string => {
  const ordinal = nextOrdinal++
  return JSON.stringify({
    schemaVersion: 1,
    recordId: randomUUID(),
    sessionId,
    threadId: 'main',
    creationOrdinal: String(ordinal),
    updateOrdinal: String(ordinal),
    occurredAt: at,
    actor: { role: 'system' },
    source: { channel: 'sdk' },
    payload: { kind: 'session-meta', metaKind: 'queue-operation', fields: { operation, timestamp: at, sessionId, ...fields } },
  })
}
const lead = readText(sessionFile!).endsWith('\n') ? '' : '\n'
appendFileSync(
  sessionFile!,
  `${lead}${queueRecord('enqueue', { content: heldDone, mode: 'task-notification', sentAt: at })}\n${queueRecord('enqueue', { content: LINE, commandUuid: LINE_UUID, mode: 'prompt', sentAt: at })}\n${queueRecord('enqueue', { content: heldLiveStop, mode: 'task-notification', sentAt: at })}\n`,
)
tally.check('the seeded rows read back through the queue journal\'s own shape', queueJournal(join(crashHome, 'projects')).filter(r => r.operation === 'enqueue' && (r.content === heldDone || r.content === LINE || r.content === heldLiveStop)).length === 3)
cpSync(crashHome, stopHome, { recursive: true })
cpSync(crashHome, plainHome, { recursive: true })

async function carriedLeg(home: string, reason: 'crash' | 'stop', row: string): Promise<void> {
  tally.section(reason === 'crash' ? 'a restart after a crash carries everything: the finished one delivered from its receipt, the running one relaunched (its stop notice held back), the operator\'s line re-queued, one row' : 'a restart after a stop (the roster killed the runner on a stop road) carries the same, and its row says the stop')
  stage = 'restart'
  const from = queueJournal(join(home, 'projects')).length
  const startedAt = Date.now()
  const runner = bootRunner({ cwd, env: envFor(home, reason), extraArgv: ['--resume', sessionId] })
  await waitUntil(() => enqueuedAfter(home, from).length >= 3, bound(60_000))
  await waitUntil(() => fixture.requests.some(r => isLive(r) && r.atMs >= startedAt), bound(30_000))
  await waitUntil(() => noticesFor(enqueuedAfter(home, from), live!.agentId, 'completed').length > 0, bound(30_000))
  const rows = enqueuedAfter(home, from)
  tally.check('the finished agent is delivered from its receipt: its held completion notice is enqueued again, byte for byte', rows.some(r => r.content === heldDone), JSON.stringify(rows.map(r => r.content.slice(0, 100))))
  tally.check('the finished agent gets no stop notice', noticesFor(rows, done!.agentId, 'killed').length === 0)
  tally.check('the finished agent is not relaunched', !fixture.requests.some(r => isDone(r) && r.atMs >= startedAt))
  tally.check('the running agent is relaunched from its transcript: its next request reaches the wire after the restart', fixture.requests.some(r => isLive(r) && r.atMs >= startedAt), `${fixture.requests.filter(r => r.atMs >= startedAt).length} requests after the restart`)
  tally.check("the running agent's held stop notice is held back (one truth per agent: it runs again)", !rows.some(r => r.content === heldLiveStop) && noticesFor(rows, live!.agentId, 'killed').length === 0, JSON.stringify(noticesFor(rows, live!.agentId, 'killed').map(r => r.content.slice(0, 80))))
  const relaunchAsk = fixture.requests.find(r => isLive(r) && r.atMs >= startedAt)
  tally.check('the relaunched agent reads the relaunch note and the writes it had landed', relaunchAsk !== undefined && /relaunched from your transcript/.test(relaunchAsk.ask) && /2 file writes landed/.test(relaunchAsk.ask), relaunchAsk?.ask.slice(0, 200))
  tally.check("the relaunched agent's end rides the live road: a completed notice carrying its reply", noticesFor(rows, live!.agentId, 'completed').some(r => r.content.includes(RELAUNCH_REPLY)))
  tally.check(`one row tells the operator what the restart carried, in the ruled words: ${row}`, rows.filter(r => r.content === row).length === 1, JSON.stringify(rows.filter(r => r.content.startsWith('runner restarted')).map(r => r.content)))
  const lineRan = await waitUntil(() => fixture.requests.some(r => isLine(r) && r.atMs >= startedAt), bound(30_000))
  tally.check("the operator's line that died with the runner is re-queued and runs as a turn", lineRan, `${fixture.requests.filter(r => r.atMs >= startedAt).length} requests after the restart`)
  const homeSession = mainTranscripts(home).find(p => basename(p) === `${sessionId}.jsonl`) ?? ''
  const lineRows = inputRowsWith(homeSession, LINE)
  tally.check('…under its original identity (the input record carries the line\'s uuid)', lineRows.some(r => (r.annotations as { uuid?: string } | undefined)?.uuid === LINE_UUID || r.recordId === LINE_UUID), JSON.stringify(lineRows.map(r => ({ recordId: r.recordId, annotations: r.annotations }))).slice(0, 300))
  const asked = Date.now()
  runner.send(user(QUESTION, randomUUID()))
  const readBack = await waitUntil(() => fixture.requests.some(r => r.atMs >= asked && !isLive(r) && !isDone(r) && textsOf(r).includes(DONE_REPLY)), bound(60_000))
  tally.check("the main agent reads the finished agent's result, not a stop", readBack)
  const started = await runner.waitFor("the relaunched agent's start frame", f => f.type === 'system' && f.subtype === 'task_started' && f.task_id === live!.agentId, bound(20_000))
  tally.check('the relaunch announces itself with a task_started frame under the agent id and its launch tool-use id', started !== null && started.tool_use_id === live!.toolUseId, JSON.stringify(started).slice(0, 200))
  await runner.stop(bound(8_000))
  if (tally.failed() > 0) console.log(`  stderr tail: ${runner.stderr().trim().split('\n').slice(-2).join(' | ').slice(0, 240)}`)
}

await carriedLeg(crashHome, 'crash', CRASH_ROW)
await carriedLeg(stopHome, 'stop', STOP_ROW)

tally.section('a plain resume keeps its words: both agents get the stop notice, no row, nothing relaunched, nothing re-queued (a plain runner drains on its first message — the journal rows land with it)')
{
  const from = queueJournal(join(plainHome, 'projects')).length
  const startedAt = Date.now()
  const third = bootRunner({ cwd, env: envFor(plainHome), extraArgv: ['--resume', sessionId] })
  third.send(user(QUESTION, randomUUID()))
  await waitUntil(() => fixture.requests.some(r => r.atMs >= startedAt && !isLive(r) && !isDone(r) && textsOf(r).includes(QUESTION)), bound(60_000))
  await waitUntil(() => enqueuedAfter(plainHome, from).length >= 2, bound(20_000))
  await sleep(bound(1_000))
  const plainRows = enqueuedAfter(plainHome, from)
  const plainStop = (agentId: string): boolean => noticesFor(plainRows, agentId, 'killed').some(r => r.content.includes("the session's runner restarted before it finished"))
  tally.check('both agents get the stop notice in the plain words', plainStop(done!.agentId) && plainStop(live!.agentId), JSON.stringify(plainRows.map(r => r.content.slice(0, 160))))
  tally.check('no row on a plain resume', !plainRows.some(r => r.content.startsWith('runner restarted')))
  tally.check('the held completion is not delivered on a plain resume', !plainRows.some(r => r.content === heldDone))
  tally.check('nothing is relaunched and the line is not re-queued on a plain resume', !fixture.requests.some(r => (isLive(r) || isDone(r) || isLine(r)) && r.atMs >= startedAt))
  await third.stop(bound(8_000))
}

await Promise.race([fixture.close(), sleep(bound(5_000))])
await removeWorld(root)
tally.finish()
