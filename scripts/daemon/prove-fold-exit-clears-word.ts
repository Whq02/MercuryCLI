#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const HOME = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'fold-exit-word-'))
const CONFIG = join(HOME, 'config')
const DAEMON_DIR = join(HOME, 'daemon')
const PROJECT = join(HOME, 'project')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.env.MERCURY_CONFIG_DIR = CONFIG
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function fence(label: string, detail: string): void {
  console.log(`  [FENCE] ${label} — ${detail}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the fold-exit word proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.ts')
const { withFoldStatus } = await import('../../src/services/compact/compact.ts')
const { isTurnOpenRow, isOutcomeRow } = await import('../../src/daemon/longLivedSupervisor.ts')
const { compactionClearedRow, compactionRow, heartbeatRow, waitRow, partialRowsOf, itemRowsOf, stepRow, turnStartedRow, turnWaitingRow, outcomeRow, sessionRow } = await import('../../src/rows/project.ts')
const { onSeatRow } = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { publishSessionFacts, publishSessionTail, readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { FOLD_EXIT_LINGER_MS, FOLD_ROW_HEAD, foldRowVisible } = await import('../../src/services/compact/foldStatus.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')

type Frame = Record<string, unknown>
type Live = { inFlight: boolean; phase: string; agentsWaiting: number }
type Fold = { trigger: string; exit?: string; endedAtMs?: number; startedAtMs: number } | null

const SID = '00000000-aaaa-bbbb-cccc-000000000701'
const SHORT = 'concourse-w1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: SID,
    workspaceId: PROJECT,
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: SID, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, DAEMON_DIR)
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }

const base = (extra: Record<string, unknown>) => ({
  isSidechain: false,
  entrypoint: 'cli',
  cwd: PROJECT,
  sessionId: SID,
  version: '1.0.0-beta.1',
  gitBranch: 'main',
  ...extra,
})
const U1 = '00000000-0000-4000-8000-000000000711'
const A1 = '00000000-0000-4000-8000-000000000712'
const U2 = '00000000-0000-4000-8000-000000000713'
const A2 = '00000000-0000-4000-8000-000000000714'
const U3 = '00000000-0000-4000-8000-000000000715'
const TOOL_USE_ID = 'toolu_fold_exit_001'
const seedRows = [
  base({ parentUuid: null, type: 'user', uuid: U1, message: { role: 'user', content: 'run the agents and wait for them' }, timestamp: '2026-06-19T12:00:01.000Z' }),
  base({
    parentUuid: U1,
    type: 'assistant',
    uuid: A1,
    requestId: 'req_lead_1',
    message: { id: 'msg_lead_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'the agents are running; I will wait for them.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    timestamp: '2026-06-19T12:00:02.000Z',
  }),
]
const nextTurnRows = [
  base({ parentUuid: A1, type: 'user', uuid: U2, message: { role: 'user', content: 'read the landings' }, timestamp: '2026-06-19T12:00:03.000Z' }),
  base({
    parentUuid: U2,
    type: 'assistant',
    uuid: A2,
    requestId: 'req_lead_2',
    message: { id: 'msg_lead_2', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Read', input: { file_path: '/scratch/REPORT.md' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    timestamp: '2026-06-19T12:00:04.000Z',
  }),
]
const toolResultRows = [
  base({ parentUuid: A2, type: 'user', uuid: U3, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'the report' }] }, timestamp: '2026-06-19T12:00:05.000Z' }),
]
const allLines = encodeSeedTranscript([...seedRows, ...nextTurnRows, ...toolResultRows], SID).split('\n')
const transcriptPath = join(PROJECT, `${SID}.jsonl`)
writeFileSync(transcriptPath, allLines.slice(0, seedRows.length).join('\n') + '\n')
const appendRows = (from: number, to: number): void => {
  appendFileSync(transcriptPath, allLines.slice(from, to).join('\n') + '\n')
}

const facts = (busy: boolean) => ({
  schema: 1 as const,
  sessionId: SID,
  atMs: Date.now(),
  model: { effective: 'claude-opus-5', setting: null },
  usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default' as const,
  workspace: { cwd: PROJECT, originalCwd: PROJECT, projectRoot: PROJECT, instructionRoots: [] },
  queue: [],
  pendingModel: null,
  busy,
})
publishSessionFacts(facts(false) as never, DAEMON_DIR)

const wireLog: Frame[] = []
let turnOpen = false
let wireSeq = 0
const wire = (frame: Frame): void => {
  const row = { seq: ++wireSeq, timestamp: new Date().toISOString(), ...frame } as Frame
  wireLog.push(row)
  if (isTurnOpenRow(row as never) && !turnOpen) {
    turnOpen = true
    publishSessionFacts(facts(true) as never, DAEMON_DIR)
  }
  if (isOutcomeRow(row as never)) {
    turnOpen = false
    publishSessionFacts(facts(false) as never, DAEMON_DIR)
  }
  onSeatRow(SHORT, row as never, roster as never, DAEMON_DIR)
}
const scope = { session_id: SID, turn: 1 }
const USAGE = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
let openFold: 'manual' | 'auto' | 'overflow' | null = null
const foldRow = (fold: unknown): Frame => {
  const row = compactionRow(scope, (fold !== null && typeof fold === 'object' ? fold : null) as never)
  openFold = row.state === 'ended' ? null : row.trigger
  return row as Frame
}
const statusRowOf = (status: unknown): Frame | null => {
  if (status === 'compacting') return foldRow(null)
  if (status === null) {
    if (openFold === null) return null
    const row = compactionClearedRow(scope, openFold) as Frame
    openFold = null
    return row
  }
  if (typeof status !== 'object') return null
  const record = status as { wait?: unknown; streamActivity?: number; compacting?: unknown }
  if ('wait' in record) return waitRow(scope, (record.wait ?? null) as never) as Frame
  if ('streamActivity' in record) return heartbeatRow(scope) as Frame
  if ('compacting' in record) return foldRow(record.compacting)
  return null
}
const wireStatus = (status: unknown): void => {
  const row = statusRowOf(status)
  if (row !== null) wire(row)
}
const resultFrame = (): Frame => outcomeRow(scope, { turnId: randomUUID(), status: 'completed', stopReason: 'end_turn', answer: '', steps: 1, wallMs: 1, usage: USAGE, models: [], denials: [] }) as Frame
const turnRow = (): Frame => turnStartedRow(scope, { turnId: randomUUID(), messageIds: [randomUUID()], model: 'claude-opus-5' }) as Frame
const initFrame = (): Frame => sessionRow(scope, { version: '0', cwd: PROJECT, model: 'claude-opus-5', mode: 'default', tools: [], mcpServers: [], commands: [], agents: [], skills: [], extensions: [] }) as Frame
const streamEvents = (messageId: string, event: Frame): Frame[] => partialRowsOf(scope, messageId, event as never) as Frame[]
const assistantRows = (id: string, content: Frame[]): Frame[] => [...(itemRowsOf(scope, id, content) as Frame[]), stepRow(scope, { messageId: id, model: 'claude-opus-5', stopReason: 'end_turn', usage: USAGE }) as Frame]
const foldContext = () => ({ setSDKStatus: wireStatus, abortController: new AbortController(), setStreamMode: () => {}, setResponseLength: () => {}, onCompactProgress: () => {} })

type Turn = (onMessage: (m: Frame) => void) => Promise<void>
const turns = new Map<string, Turn>()
const queue: Array<{ value: string; mode: 'prompt'; uuid: string }> = []
let agentsRunning = true
const driver = createTurnDriver({
  dequeue: () => queue.shift() as never,
  dequeueCommand: command => {
    const at = queue.indexOf(command as never)
    return at >= 0 ? (queue.splice(at, 1)[0] as never) : undefined
  },
  peek: () => queue[0] as never,
  notifyLifecycle: () => {},
  enqueueOutput: message => wire(message as unknown as Frame),
  writeDirect: async message => {
    wire(message as unknown as Frame)
  },
  drainRows: () => [],
  executeTurn: async (command, _batch, onMessage) => {
    const turn = turns.get(String(command.value))
    if (turn === undefined) throw new Error(`no scripted turn for ${String(command.value)}`)
    await turn(m => onMessage(m as never))
  },
  beforeCycle: async () => {},
  onTurnStart: () => {},
  turnIdOf: () => 't-fold',
  openTurnRow: messageIds => turnStartedRow(scope, { turnId: 't-fold', messageIds, model: 'claude-opus-5' }) as never,
  onTurnSettled: () => {},
  hasWaitableBackgroundTasks: () => agentsRunning,
  hasHoldableBackgroundAgents: () => agentsRunning,
  waitableBackgroundTaskCount: () => (agentsRunning ? 1 : 0),
  onAgentWait: (count, turnId) => wire(turnWaitingRow(scope, { turnId, agents: count }) as Frame),
  settleIdle: async () => 'stay',
  closeOutput: async () => {},
  notifySessionState: () => {},
  isShuttingDown: () => false,
  idleTimerStop: () => {},
  idleTimerStart: () => {},
  onCycleError: (error, turnId) => outcomeRow(scope, { turnId, status: 'failed', stopReason: null, error: { message: String(error), class: 'internal' }, steps: 0, wallMs: 0, usage: USAGE, models: [], denials: [] }) as never,
  shutdown: () => {},
  clock: { sleep },
})
const enqueue = (value: string): void => {
  queue.push({ value, mode: 'prompt', uuid: randomUUID() })
  driver.kick()
}

const record = { sessionId: SID, runnerId: SHORT, title: 'fold exit word', projectLabel: 'scratch', workspaceId: PROJECT, home: PROJECT }
const cockpit = new DaemonSessionConnector(record as never)
await cockpit.attach()
const live = (): Live => cockpit.live() as Live
const fold = (): Fold => (typeof cockpit.fold === 'function' ? (cockpit.fold() as Fold) : null)
const tail = (): { stateWord?: string; fold?: { exit?: string } } | null => readSessionTail(SID, DAEMON_DIR) as never
const rowVisible = (): boolean => foldRowVisible(fold() as never, { landingPainted: false, nowMs: Date.now() })
const compactionRowsOnWire = (): Frame[] => wireLog.filter(f => f.type === 'compaction')
const resultFramesOnWire = (): number => wireLog.filter(f => f.type === 'outcome').length
const emit = (onMessage: (m: Frame) => void, rows: Frame[]): void => rows.forEach(onMessage)

section('P0 the seat opens idle (the control)')
check('the cockpit reads the seat idle before any turn', live().inFlight === false && live().phase === 'idle', j(live()))

section("P1 the lead's turn ends while its agents run: the driver holds the result and announces the wait")
{
  turns.set('lead turn', async onMessage => {
    onMessage(initFrame())
    onMessage(turnRow())
    emit(onMessage, streamEvents('msg_lead_1', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    emit(onMessage, streamEvents('msg_lead_1', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the agents are running; I will wait for them.' } }))
    emit(onMessage, assistantRows('msg_lead_1', [{ type: 'text', text: 'the agents are running; I will wait for them.' }]))
    onMessage(resultFrame())
  })
  enqueue('lead turn')
  const waiting = await until(() => live().inFlight === true && live().phase === 'waiting')
  check("the phase reads the agent wait (the word road works: the driver's announce reached the seat and the cockpit)", waiting, j(live()))
  check('the outcome row never crossed the wire (the hold-back rule: holdable agents run)', resultFramesOnWire() === 0, `outcomes on the wire: ${resultFramesOnWire()}`)
}

section("P2 the operator's manual /compact drains into the held turn; the fold begins and speaks its own word")
let foldBeganAtMs = 0
let foldExitedAtMs = 0
let beginProbe: Live | null = null
let beginFold: Fold = null
let beginTail: ReturnType<typeof tail> = null
{
  turns.set('/compact', async onMessage => {
    onMessage(turnRow())
    await withFoldStatus(
      foldContext() as never,
      async scoped => {
        foldBeganAtMs = Date.now()
        scoped.onCompactProgress?.({ type: 'stage', stage: 'micro-compaction' })
        await until(() => live().phase === 'compacting')
        beginProbe = live()
        beginFold = fold()
        beginTail = tail()
        enqueue('read the landings')
        scoped.setSDKStatus?.('compacting')
        scoped.onCompactProgress?.({ type: 'compact_start' })
        scoped.setResponseLength?.(() => 800)
        await sleep(120)
        scoped.onCompactProgress?.({ type: 'hooks_start', hookType: 'session_start' })
        scoped.setResponseLength?.(() => 0)
        scoped.setSDKStatus?.(null)
        return 'folded'
      },
      { trigger: 'manual', sessionMemory: false, microcompaction: true },
    )
    foldExitedAtMs = Date.now()
    onMessage(resultFrame())
  })
  let nextTurnDone: () => void = () => {}
  const nextTurnHeld = new Promise<void>(resolve => {
    nextTurnDone = resolve
  })
  turns.set('read the landings', async onMessage => {
    onMessage(turnRow())
    emit(onMessage, streamEvents('msg_lead_2', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: TOOL_USE_ID, name: 'Read', input: {} } }))
    appendRows(seedRows.length, seedRows.length + nextTurnRows.length)
    emit(onMessage, assistantRows('msg_lead_2', nextTurnRows[1]!.message.content as Frame[]))
    await nextTurnHeld
    appendRows(seedRows.length + nextTurnRows.length, allLines.length - 1)
    onMessage(resultFrame())
  })
  enqueue('/compact')
  await until(() => foldExitedAtMs > 0, 10_000)
  check('the fold began under the held turn', foldBeganAtMs > 0 && beginProbe !== null && (beginProbe as Live).phase === 'compacting', j(beginProbe))
  check('at the fold begin the cockpit holds the live record (no exit) and the row stands', beginFold !== null && (beginFold as Fold)?.exit === undefined && foldRowVisible(beginFold as never, { landingPainted: false, nowMs: foldBeganAtMs }), j(beginFold))
  fence('the tail projection at the fold begin', j(beginTail))

  section('P3 the fold exits landed; the next queued turn drains at once and calls a tool')
  const exitStamp = compactionRowsOnWire().findLast(f => f.state === 'ended') as { state: string; exit?: string; stage?: unknown } | undefined
  check('the exit stamp reached the wire with exit=landed (the record is right; the throttle dropped nothing)', exitStamp?.exit === 'landed' && Array.isArray((exitStamp as { stages?: unknown }).stages), j(exitStamp))
  const framesAfterExit = wireLog.slice(wireLog.indexOf(exitStamp as never) + 1)
  fence('the rows the runner wrote after the exit stamp', j(framesAfterExit.map(f => `${String(f.type)}${typeof f.state === 'string' ? `/${f.state}` : ''}${f.type === 'compaction' ? `:${j({ stage: f.stage, exit: f.exit })}` : ''}`)))
  check("the /compact turn's outcome never crossed the wire either (held back for the agents), and no compaction row after the exit re-opens the word", resultFramesOnWire() === 0 && !framesAfterExit.some(f => f.type === 'compaction'), `outcomes: ${resultFramesOnWire()}`)
  const toolCalled = await until(() => wireLog.some(f => f.type === 'tool_call' && f.message_id === 'msg_lead_2'))
  check("the next turn's first tool call landed on the wire (the transcript carries the unresolved tool_use)", toolCalled)
  await sleep(600)
  const tailAfterExit = tail()
  fence('the tail projection after the exit and the tool call', j(tailAfterExit))
  check('the tail projection carries the exited record (exit=landed)', tailAfterExit?.fold?.exit === 'landed', j(tailAfterExit))
  const wordLeft = await until(() => live().phase !== 'compacting', 2000)
  check("THE DEFECT PIN: after the fold exited and the next turn's tool call is running, the phase is no longer 'compacting'", wordLeft, `phase=${live().phase} tail.stateWord=${String(tailAfterExit?.stateWord)} tail.fold.exit=${String(tailAfterExit?.fold?.exit)}`)
  check("the next turn's activity word wins: the phase is the tool call's", live().phase === 'tool', j(live()))

  section('P4 the linger: the exited row stands at exit + 1 s and is gone at exit + 6 s')
  await until(() => Date.now() >= foldExitedAtMs + 1000, 2000)
  const atOne = fold()
  check('at exit + 1 s the cockpit still holds the exited record for the row (exit=landed)', atOne !== null && atOne.exit === 'landed', j(atOne))
  check('at exit + 1 s the one-row law says the row stands (no landing row painted yet)', rowVisible(), j(fold()))
  await until(() => Date.now() >= foldExitedAtMs + FOLD_EXIT_LINGER_MS + 1000, FOLD_EXIT_LINGER_MS + 2000)
  check('at exit + 6 s the one-row law says the row is gone', !rowVisible(), j(fold()))
  check('at exit + 6 s the cockpit hands the row no record (the linger is over)', fold() === null, j(fold()))
  check("at exit + 6 s the phase is still not 'compacting' (the word never came back)", live().phase !== 'compacting', j(live()))

  section("P5 the next turn settles and the agents end: the held results flush and the seat rests")
  nextTurnDone()
  await until(() => wireLog.some(f => f.type === 'tool_call' && f.message_id === 'msg_lead_2') && turns.has('read the landings'))
  await sleep(200)
  agentsRunning = false
  const idle = await until(() => live().inFlight === false && live().phase === 'idle', 5000)
  check('the held result flushes once the agents end and the seat reads idle', idle, j(live()))
  check("one outcome crossed the wire in the end (the driver's one held slot keeps the last envelope)", resultFramesOnWire() === 1, `outcomes: ${resultFramesOnWire()}`)
  check('the settle hands the row no record past the linger (the latch is bounded by the exit clock too)', fold() === null, j(fold()))
}

section('P6 the automatic road (the seat and the cockpit over the fixture projection; the real mid-turn ended row is prove-compaction-hold R4): a fold inside a turn clears its word with its ended row')
{
  agentsRunning = true
  let during: Live | null = null
  let after: Live | null = null
  let autoDone: () => void = () => {}
  const autoHeld = new Promise<void>(resolve => {
    autoDone = resolve
  })
  turns.set('auto fold turn', async onMessage => {
    onMessage(turnRow())
    await withFoldStatus(
      foldContext() as never,
      async scoped => {
        scoped.onCompactProgress?.({ type: 'compact_start' })
        await until(() => live().phase === 'compacting')
        during = live()
        await sleep(60)
        return 'auto folded'
      },
      { trigger: 'auto', sessionMemory: false, microcompaction: false },
    )
    await until(() => live().phase !== 'compacting', 2000)
    after = live()
    emit(onMessage, streamEvents('msg_lead_3', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
    await autoHeld
    emit(onMessage, assistantRows('msg_lead_3', [{ type: 'thinking', thinking: 'hm' }]))
    onMessage(resultFrame())
  })
  enqueue('auto fold turn')
  await until(() => after !== null, 10_000)
  check("during the automatic fold the phase is 'compacting'", during !== null && (during as Live).phase === 'compacting', j(during))
  check("after the automatic fold's ended row the phase leaves 'compacting' while the turn runs on", after !== null && (after as Live).phase !== 'compacting' && (after as Live).inFlight === true, j(after))
  const thinking = await until(() => live().phase === 'thinking', 2000)
  check("the turn's next activity word wins (a thinking block)", thinking, j(live()))
  autoDone()
  agentsRunning = false
  const idle = await until(() => live().inFlight === false, 5000)
  check('the seat rests after the automatic road', idle && live().phase === 'idle', j(live()))
}

section("P8 an older daemon's tail (the word standing over an exited record): the cockpit ranks the record's exit above the word")
{
  const t0 = Date.now()
  const oldShapedFold = { schema: 1, trigger: 'manual', startedAtMs: t0 - 3000, stages: ['micro-compaction', 'summarising', 'restoring'], stage: 'restoring', fill: null, summaryTokens: 200, summaryCapTokens: 20_000, attempt: 1, exit: 'landed', endedAtMs: t0 }
  publishSessionFacts(facts(true) as never, DAEMON_DIR)
  const busy = await until(() => live().inFlight === true)
  check('the busy edge lands first (the turn is in flight before the tail speaks)', busy, j(live()))
  publishSessionTail({ schema: 1, sessionId: SID, atMs: t0, text: null, stateWord: 'compacting', fold: oldShapedFold } as never, DAEMON_DIR)
  const rowRead = await until(() => live().inFlight === true && fold() !== null && fold()?.exit === 'landed')
  check('the cockpit reads the exited record for the row under a busy edge', rowRead, `${j(fold())} ${j(live())}`)
  await sleep(500)
  fence('the tail as an older daemon writes it, and the live view over it', `${j(tail())} → ${j(live())}`)
  check("the phase is not 'compacting' over an exited record, whatever the word beside it says", live().inFlight === true && live().phase !== 'compacting', j(live()))
  await until(() => Date.now() >= t0 + FOLD_EXIT_LINGER_MS + 500, FOLD_EXIT_LINGER_MS + 1000)
  check('the row is handed no record once the linger is over', fold() === null, j(fold()))
  publishSessionTail({ schema: 1, sessionId: SID, atMs: Date.now(), text: null } as never, DAEMON_DIR)
  publishSessionFacts(facts(false) as never, DAEMON_DIR)
  await until(() => live().inFlight === false)
}

section('P7 the header paints the phase (structural): the word beside the logo is the phase and nothing else')
{
  const repl = readFileSync(join(import.meta.dir, '..', '..', 'src/screens/REPL.tsx'), 'utf8')
  check("the header's compacting dress follows seatLive.phase === 'compacting'", repl.includes("const viewCompacting = seatLive.phase === 'compacting'"))
  check(`the header's word under that dress is the fold's head ("${FOLD_ROW_HEAD}"), still`, repl.includes('viewCompacting ? FOLD_ROW_HEAD') && repl.includes('still={viewCompacting}'))
}

cockpit.detach()
console.log(failures === 0 ? '\nprove-fold-exit-clears-word: ALL LAWS HOLD' : `\nprove-fold-exit-clears-word: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
