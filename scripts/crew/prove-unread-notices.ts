#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unread-notices-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) process.env[k] = '0'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_NOTICE_DEADLINE_MS

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
const src = (rel: string): string => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '')

await import('../../src/tasks.js')
const task = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const queue = await import('../../src/utils/messageQueueManager.js')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.js')
const crew = await import('../../src/services/engine-connector/crewFacts.js')
const wire = await import('../../src/services/engine-connector/seatWire.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
type LedgerModule = typeof import('../../src/services/notices/unreadLedger.js')
type NudgeModule = typeof import('../../src/services/notices/idleNudge.js')
type NoticeRecord = import('../../src/services/notices/unreadLedger.js').NoticeRecord
type WorkRowV1 = import('../../src/services/engine-connector/types.js').WorkRowV1
let ledger: LedgerModule | null = null
let nudge: NudgeModule | null = null
try {
  ledger = await import('../../src/services/notices/unreadLedger.js')
  nudge = await import('../../src/services/notices/idleNudge.js')
} catch (e) {
  console.log(`  the ledger modules did not load: ${String(e).slice(0, 160)}`)
}

type Store = { state: { tasks: Record<string, unknown>; speculation: { status: string } } }
function makeStore(): Store & { set: (fn: (prev: never) => never) => void; get: () => unknown } {
  const store = {
    state: { tasks: {}, speculation: { status: 'idle' } } as Store['state'],
    set(fn: (prev: never) => never) {
      store.state = (fn as (p: unknown) => Store['state'])(store.state)
    },
    get() {
      return store.state
    },
  }
  return store
}
const FAKE_AGENT_DEF = { agentType: 'mercury-general', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
const NOTE = (id: string, words: string): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${words}</summary>\n</task-notification>`

let clockMs = 0
const fresh = (): void => {
  queue.resetCommandQueue()
  ledger?.resetNoticeLedger()
  ledger?.setNoticeLedgerClock(() => clockMs)
}

section('N1 — the ledger at the queue: a completion is unread until a turn takes it')
if (ledger === null) {
  check('N1 the unread-notice ledger module exists', false, 'src/services/notices/unreadLedger.ts is absent')
} else {
  const L = ledger
  fresh()
  clockMs = 1_000
  const store = makeStore()
  task.registerAsyncAgent({ agentId: 'ag-1', description: 'reads the tree', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.enqueueAgentNotification({ taskId: 'ag-1', description: 'reads the tree', status: 'completed', setAppState: store.set as never })
  const open = L.openNotices()
  check('N1 the completion notice is one unread row for the main thread', open.length === 1 && open[0]!.agentId === L.MAIN_THREAD_AGENT && open[0]!.kind === 'completion' && open[0]!.state === 'unread', JSON.stringify(open))
  check('N1 the row carries the notice in a line and its delivery clock', open[0]?.words === 'Agent "reads the tree" completed' && open[0]?.deliveredAtMs === 1_000, JSON.stringify(open[0]))
  check('N1 the main thread counts one unread', L.unreadNoticeCount(L.MAIN_THREAD_AGENT) === 1)
  clockMs = 1_400
  const taken = queue.dequeue()
  check('N1 the driver\'s dequeue consumes it: read, at the clock of the take', taken !== undefined && L.openNotices().length === 0 && L.noticeRows()[0]?.state === 'consumed' && L.noticeRows()[0]?.consumedAtMs === 1_400, JSON.stringify(L.noticeRows()))
  queue.enqueuePendingNotification({ value: NOTE('t2', 'Agent "writes the plan" completed'), mode: 'task-notification', priority: 'next' })
  const ref = queue.getDrainableCommands(false)[0]!
  queue.remove([ref])
  check('N1 the mid-turn drain\'s remove consumes it too', L.openNotices().length === 0 && L.noticeRows()[0]?.state === 'consumed', JSON.stringify(L.noticeRows()))
  queue.enqueue({ value: NOTE('t3', 'Agent "counts the files" completed'), mode: 'task-notification', priority: 'next', agentId: 'ag-2' })
  check('N1 an addressed notice is unread for its agent, not the main thread', L.unreadNoticeCount('ag-2') === 1 && L.unreadNoticeCount(L.MAIN_THREAD_AGENT) === 0)
  queue.dequeueAllMatching(c => c.agentId === 'ag-2')
  const discarded = L.noticeRows().find(r => r.agentId === 'ag-2')
  check('N1 a notice discarded with its agent retires, and says so', discarded?.state === 'retired' && discarded.retiredWhy === 'discarded when its agent was stopped', JSON.stringify(discarded))
  const uuid = '4f6c1b2e-0000-4000-8000-000000000001'
  queue.enqueue({ value: NOTE('t4', 'Agent "sorts the list" completed'), mode: 'task-notification', priority: 'next', agentId: 'ag-2', uuid: uuid as never })
  const pop = queue.popById(uuid)
  const popped = L.noticeRows().find(r => r.words === 'Agent "sorts the list" completed')
  check('N1 a notice taken back before a turn read it retires with that reason', pop.popped && popped?.state === 'retired' && popped.retiredWhy === 'taken back before a turn read it', JSON.stringify(popped))
  queue.enqueue({ value: 'please look at the failing test', mode: 'prompt' })
  check('N1 an operator\'s line is not a notice', L.openNotices().length === 0)
  queue.enqueue({ value: 'the morning check', mode: 'prompt', priority: 'later', isMeta: true, workload: 'cron' })
  const wake = L.openNotices().find(r => r.kind === 'wake')
  check('N1 a schedule\'s line is a wake for the main thread', wake !== undefined && wake.agentId === L.MAIN_THREAD_AGENT && wake.words === 'scheduled wake: the morning check', JSON.stringify(wake))
  queue.enqueuePendingNotification({ value: '<monitor task="m1" name="build watch">\nBUILD OK\n</monitor>', mode: 'task-notification', priority: 'next', agentId: 'ag-2' })
  const tick = L.openNotices().find(r => r.agentId === 'ag-2')
  check('N1 a monitor\'s tick names its monitor', tick?.kind === 'completion' && tick.words === 'monitor "build watch" reported', JSON.stringify(tick))
  check('N1 the facts rows list the open rows first, oldest first, then the settled', L.noticeRows()[0]?.kind === 'wake' && L.noticeRows()[1]?.words === 'monitor "build watch" reported' && L.noticeRows().slice(2).every(r => r.state === 'consumed' || r.state === 'retired'), JSON.stringify(L.noticeRows().map(r => [r.kind, r.state])))
}

section('N2 — a message queued for a sub-agent is unread until its next tool round')
if (ledger === null) {
  check('N2 the ledger module exists', false)
} else {
  const L = ledger
  fresh()
  clockMs = 2_000
  const store = makeStore()
  task.registerAsyncAgent({ agentId: 'ag-3', description: 'runs the tests', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.queuePendingMessage('ag-3', 'please stop after the unit tests\nand report the count', store.set as never)
  const row = L.openNotices()[0]
  check('N2 the message is one unread row for that agent, its first words as the line', row !== undefined && row.agentId === 'ag-3' && row.kind === 'message' && row.words === 'please stop after the unit tests' && L.unreadNoticeCount('ag-3') === 1, JSON.stringify(row))
  task.queuePendingMessage('ag-9', 'nobody home', store.set as never)
  check('N2 a message for an agent this session does not hold records nothing', L.openNotices().length === 1)
  clockMs = 2_500
  const drained = task.drainPendingMessages('ag-3', store.get as never, store.set as never)
  check('N2 the agent\'s tool round drains it: read', drained.length === 1 && L.unreadNoticeCount('ag-3') === 0 && L.noticeRows()[0]?.state === 'consumed' && L.noticeRows()[0]?.consumedAtMs === 2_500, JSON.stringify(L.noticeRows()))
}

section('N3 — the idle nudge: the deadline reads the flag; an idle agent is woken once per notice; a read notice is never nudged')
if (ledger === null || nudge === null) {
  check('N3 the idle nudge module exists', false, 'src/services/notices/idleNudge.ts is absent')
} else {
  const L = ledger
  const N = nudge
  delete process.env.MERCURY_NOTICE_DEADLINE_MS
  check('N3 unset, the deadline is the product\'s three minutes', N.noticeDeadlineMs() === 180_000 && N.NOTICE_DEADLINE_DEFAULT_MS === 180_000)
  process.env.MERCURY_NOTICE_DEADLINE_MS = '1500'
  check('N3 the deadline reads the flag', N.noticeDeadlineMs() === 1_500)
  process.env.MERCURY_NOTICE_DEADLINE_MS = '20'
  check('N3 a value below the floor reads as unset', N.noticeDeadlineMs() === 180_000)
  process.env.MERCURY_NOTICE_DEADLINE_MS = 'soon'
  check('N3 a value that is not a whole number reads as unset', N.noticeDeadlineMs() === 180_000)
  process.env.MERCURY_NOTICE_DEADLINE_MS = '1500'
  const spec = getFlagSpec('MERCURY_NOTICE_DEADLINE_MS')
  check('N3 the flag has its registry row: a value knob whose consumer is the nudge', spec?.kind === 'value' && spec.consumer === 'src/services/notices/idleNudge.ts' && src(spec.consumer).includes("flagEnv('MERCURY_NOTICE_DEADLINE_MS')"), JSON.stringify(spec))

  fresh()
  clockMs = 0
  let recipient: 'idle' | 'busy' = 'idle'
  const wakes: Array<{ agentId: string; ids: string[]; at: number }> = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const nudger = N.startIdleNudge({
    recipient: agentId => (agentId === L.MAIN_THREAD_AGENT ? { state: recipient } : { state: 'gone', why: 'not in this proof' }),
    wake: (agentId, notices) => {
      wakes.push({ agentId, ids: notices.map(n => n.id), at: clockMs })
      return true
    },
    now: () => clockMs,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
  })
  check('N3 nothing open, nothing armed', timers.length === 0)
  queue.enqueuePendingNotification({ value: NOTE('t5', 'Agent "reads the tree" completed'), mode: 'task-notification', priority: 'next' })
  check('N3 a delivered notice arms the sweep at the deadline, from its own delivery clock', timers.length === 1 && timers[0]!.ms === 1_500, JSON.stringify(timers.map(t => t.ms)))
  clockMs = 1_499
  let receipt = nudger.sweep()
  check('N3 one millisecond short of the deadline, no wake; the next sweep arms at the floor, never a spin', wakes.length === 0 && receipt.nudged.length === 0 && receipt.nextInMs === 25, JSON.stringify(receipt))
  clockMs = 1_500
  receipt = nudger.sweep()
  const first = L.noticeRows()[0]
  check('N3 at the deadline the idle main thread is woken with the notice', wakes.length === 1 && wakes[0]!.agentId === L.MAIN_THREAD_AGENT && wakes[0]!.ids.length === 1 && receipt.nudged.length === 1, JSON.stringify(wakes))
  check('N3 the row reads nudged, stamped, and still counts as unread until a turn takes it', first?.state === 'nudged' && first.nudgedAtMs === 1_500 && L.unreadNoticeCount(L.MAIN_THREAD_AGENT) === 1, JSON.stringify(first))
  check('N3 the sweep has nothing more to arm for a nudged row', receipt.nextInMs === null, JSON.stringify(receipt))
  clockMs = 4_000
  receipt = nudger.sweep()
  check('N3 once per notice: a later sweep never wakes for it again', wakes.length === 1 && receipt.nudged.length === 0)
  clockMs = 4_100
  queue.dequeue()
  const took = L.noticeRows()[0]
  check('N3 the turn takes it: read, the nudge stamp kept', took?.state === 'consumed' && took.consumedAtMs === 4_100 && took.nudgedAtMs === 1_500, JSON.stringify(took))
  clockMs = 5_000
  queue.enqueuePendingNotification({ value: NOTE('t6', 'Agent "writes the plan" completed'), mode: 'task-notification', priority: 'next' })
  clockMs = 5_100
  queue.dequeue()
  clockMs = 9_000
  receipt = nudger.sweep()
  check('N3 a notice a turn read before the deadline is never nudged', wakes.length === 1 && receipt.nudged.length === 0 && L.noticeRows()[0]?.state === 'consumed' && L.noticeRows()[0]?.nudgedAtMs === undefined)
  clockMs = 10_000
  recipient = 'busy'
  queue.enqueuePendingNotification({ value: NOTE('t7', 'Agent "counts the files" completed'), mode: 'task-notification', priority: 'next' })
  clockMs = 12_000
  receipt = nudger.sweep()
  check('N3 a busy agent is not nudged: its own next round reads the notice; the sweep waits a whole deadline', wakes.length === 1 && receipt.waiting === 1 && receipt.nextInMs === 1_500, JSON.stringify(receipt))
  recipient = 'idle'
  clockMs = 13_500
  receipt = nudger.sweep()
  check('N3 the agent idle again past the deadline is woken', wakes.length === 2 && receipt.nudged.length === 1)
  queue.dequeue()
  process.env.MERCURY_NOTICE_DEADLINE_MS = '4000'
  clockMs = 20_000
  queue.enqueuePendingNotification({ value: NOTE('t8', 'Agent "sorts the list" completed'), mode: 'task-notification', priority: 'next' })
  clockMs = 23_999
  receipt = nudger.sweep()
  const early = wakes.length
  clockMs = 24_000
  receipt = nudger.sweep()
  check('N3 the deadline is the flag\'s number, read live — never a clock of the code\'s own', early === 2 && wakes.length === 3 && wakes[2]!.at === 24_000, JSON.stringify(wakes))
  const words = N.nudgeWords(L.noticeRows().filter(r => r.state === 'nudged') as NoticeRecord[], 4_000)
  check('N3 the wake\'s words: how many waited, how long, and each notice in a line', words.startsWith('<system-reminder>\n1 notice waited unread for 4s while you were idle — it arrives as the turn just before this one; read it and act on anything still open:\n- Agent "sorts the list" completed') && words.endsWith('</system-reminder>'), words)
  const two = N.nudgeWords([{ words: 'a' } as NoticeRecord, { words: 'b' } as NoticeRecord], 125_000, ['<one/>', '<two/>'])
  check('N3 the words for a wake that carries the notices itself', two.includes('2 notices waited unread for 2m 5s while you were idle — here they are, oldest first:\n- a\n- b\n\n<one/>\n\n<two/>'), two)
  nudger.stop()
  process.env.MERCURY_NOTICE_DEADLINE_MS = '1500'
}

section('N4 — an agent gone before the nudge: the notice retires with a facts row saying so')
if (ledger === null || nudge === null) {
  check('N4 the modules exist', false)
} else {
  const L = ledger
  const N = nudge
  fresh()
  clockMs = 0
  const store = makeStore()
  task.registerAsyncAgent({ agentId: 'ag-4', description: 'the finished one', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.registerAsyncAgent({ agentId: 'ag-5', description: 'the running one', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.registerAsyncAgent({ agentId: 'ag-6', description: 'the stopped one', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never })
  task.completeAgentTask({ agentId: 'ag-4' }, store.set as never)
  task.killAsyncAgent('ag-6', store.set as never, 'stopped from the crew view')
  const tasks = () => store.state.tasks as never
  check('N4 a completed agent is gone — its run ended', JSON.stringify(N.agentRecipientState(tasks(), 'ag-4')) === JSON.stringify({ state: 'gone', why: 'its run ended' }), JSON.stringify(N.agentRecipientState(tasks(), 'ag-4')))
  check('N4 a running agent is busy — its own round reads its notices', N.agentRecipientState(tasks(), 'ag-5').state === 'busy')
  check('N4 a stopped agent is gone — it was stopped', JSON.stringify(N.agentRecipientState(tasks(), 'ag-6')) === JSON.stringify({ state: 'gone', why: 'it was stopped' }))
  check('N4 an id this session never held is gone', JSON.stringify(N.agentRecipientState(tasks(), 'ag-none')) === JSON.stringify({ state: 'gone', why: 'no agent by that id in this session' }))
  queue.enqueue({ value: NOTE('t9', 'Agent "its helper" completed'), mode: 'task-notification', priority: 'next', agentId: 'ag-4' })
  queue.enqueue({ value: NOTE('t10', 'Agent "its other helper" completed'), mode: 'task-notification', priority: 'next', agentId: 'ag-5' })
  const wakes: string[] = []
  const discarded: string[][] = []
  const nudger = N.startIdleNudge({
    recipient: agentId => N.agentRecipientState(tasks(), agentId),
    wake: agentId => {
      wakes.push(agentId)
      return true
    },
    discard: notices => {
      discarded.push(notices.map(n => n.id))
      const keys = new Set(notices.map(n => n.key))
      queue.remove(queue.getCommandQueue().filter(c => c.queueId !== undefined && keys.has(c.queueId)))
    },
    now: () => clockMs,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  clockMs = 1_500
  const receipt = nudger.sweep()
  const gone = L.noticeRows().find(r => r.agentId === 'ag-4')
  check('N4 the gone agent\'s notice retires, once, and nothing is woken for it', receipt.retired.length === 1 && wakes.length === 0 && gone?.state === 'retired' && gone.retiredAtMs === 1_500, JSON.stringify(receipt))
  check('N4 the facts row says why', gone?.retiredWhy === 'the agent is gone — its run ended', JSON.stringify(gone))
  check('N4 its carrier left the queue; the running agent\'s notice stays for its next round', discarded.length === 1 && queue.getCommandQueue().length === 1 && queue.getCommandQueue()[0]!.agentId === 'ag-5' && receipt.waiting === 1, JSON.stringify(queue.getCommandQueue().map(c => c.agentId)))
  check('N4 the running agent still counts its unread', L.unreadNoticeCount('ag-5') === 1 && L.unreadNoticeCount('ag-4') === 0)
  nudger.stop()
  store.state = { ...store.state }
  void store
}

section('N5 — the lead\'s view: the count on the roster row, the crew facts, the wire, the crew row')
if (ledger === null) {
  check('N5 the ledger module exists', false)
} else {
  const L = ledger
  fresh()
  clockMs = 100
  const store = makeStore()
  task.registerAsyncAgent({ agentId: 'ag-7', description: 'tide-gauges', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never, model: 'claude-fable-5-1' })
  task.registerAsyncAgent({ agentId: 'ag-8', description: 'reef-survey', prompt: 'p', selectedAgent: FAKE_AGENT_DEF, setAppState: store.set as never, model: 'claude-fable-5-1' })
  queue.enqueue({ value: NOTE('t11', 'Agent "its helper" completed'), mode: 'task-notification', priority: 'next', agentId: 'ag-7' })
  task.queuePendingMessage('ag-7', 'one more thing', store.set as never)
  const rows = projectWorkRoster(store.state.tasks as never)
  const seven = rows.find(r => r.id === 'ag-7')
  const eight = rows.find(r => r.id === 'ag-8')
  check('N5 the roster row counts the agent\'s unread notices — a completion and a message', seven?.unreadNotices === 2, JSON.stringify(seven))
  check('N5 a row with none carries no count', eight !== undefined && !('unreadNotices' in eight), JSON.stringify(eight))
  const facts7 = crew.crewAgentFactsOf(seven!, 'fx-session')!
  const facts8 = crew.crewAgentFactsOf(eight!, 'fx-session')!
  check('N5 the crew facts carry the number and its one spelling', facts7.unreadNotices === 2 && crew.crewUnreadLabel(facts7) === '2 unread' && facts8.unreadNotices === 0 && crew.crewUnreadLabel(facts8) === null)
  const answer = { model: { effective: 'm', setting: null }, usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }, identity: { firstPartyApi: true, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default', workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] }, queue: [], work: rows, notices: L.noticeRows() }
  const onWire = wire.sessionFactsToWire(answer as never) as { work: Array<Record<string, unknown>>; notices: Array<Record<string, unknown>> }
  const w7 = onWire.work.find(r => r.id === 'ag-7')!
  check('N5 the wire spells the count and the rows snake_case', w7.unread_notices === 2 && !('unreadNotices' in w7) && onWire.notices.length === 2 && 'agent_id' in onWire.notices[0]! && 'delivered_at_ms' in onWire.notices[0]! && !('agentId' in onWire.notices[0]!), JSON.stringify(onWire.notices[0]))
  const back = wire.sessionFactsFromWire(JSON.parse(JSON.stringify(onWire))) as { work: WorkRowV1[]; notices: unknown[] }
  check('N5 the seat reads it back in the record\'s spelling, deep-equal', JSON.stringify(back.work) === JSON.stringify(rows) && JSON.stringify(back.notices) === JSON.stringify(L.noticeRows()), JSON.stringify(back.notices))
  let painted = ''
  let plain = ''
  try {
    await import('../../src/tools/AgentTool/AgentTool.tsx')
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
    enableConfigs()
    const React = (await import('react')).default
    const { renderToString } = await import('../../src/utils/staticRender.tsx')
    const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
    const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
    const fakeConnector = (work: { rows: WorkRowV1[]; mission: never[] }): never =>
      ({
        sessionId: () => 'fx-session',
        workRoster: () => work,
        subscribeWork: () => () => {},
        subscribeRecords: () => () => {},
        identity: () => ({ firstPartyApi: true, consoleBilling: false, claudeAiBilling: false, accountEmail: null }),
        spawnSwitches: () => ({ subagents: { on: true }, workflows: { on: true } }),
      }) as never
    setFocusedSessionConnector(fakeConnector({ rows, mission: [] }))
    painted = await renderToString(React.createElement(CrewView, { onClose: () => {} }), 120)
    setFocusedSessionConnector(fakeConnector({ rows: rows.map(r => ({ ...r, unreadNotices: undefined })), mission: [] }))
    plain = await renderToString(React.createElement(CrewView, { onClose: () => {} }), 120)
  } catch (e) {
    painted = `RENDER FAILED: ${String(e)}`
  }
  check('N5 the crew view paints', !painted.startsWith('RENDER FAILED'), painted.slice(0, 200))
  const line7 = painted.split('\n').find(l => l.includes('tide-gauges')) ?? ''
  const line8 = painted.split('\n').find(l => l.includes('reef-survey')) ?? ''
  check('N5 the crew row carries the one number on its tail — "2 unread" — and a row with none carries nothing', line7.includes('2 unread') && !line8.includes('unread'), `${line7}\n${line8}`)
  check('N5 without the count the rows paint as before', !plain.includes('unread') && plain.includes('tide-gauges'), plain.slice(0, 200))
}

section('N6 — the wiring: the runner starts the nudge and publishes the ledger; the queue and the agent task record')
{
  const print = src('src/cli/print.ts')
  check('N6 the session runner starts the idle nudge with the main thread and its agents as recipients', print.includes('startIdleNudge({') && print.includes('agentRecipientState(getAppState().tasks, agentId)') && print.includes("why: 'the session is shutting down'"), 'print.ts')
  check('N6 the runner wakes the main thread through its own queue, behind the notices', print.includes("enqueue({ value: nudgeWords(notices, waitedMs), mode: 'prompt', priority: 'later', isMeta: true"), 'print.ts')
  check('N6 the runner wakes a named agent through its pending line, with the carriers\' text, and the copies leave through the runner\'s own retire door, which speaks no completion frame', print.includes('injectUserMessageToTeammate(task.id, nudgeWords(notices, waitedMs, bodies), setAppState)') && print.includes('if (carriers.length > 0) retireQueuedCommands(carriers)') && print.includes('retiringQueuedCommands = true') && !print.includes('removeQueuedCommands(carriers)'), 'print.ts')
  check('N6 the facts answer carries the ledger', print.includes('notices: noticeRows(),'), 'print.ts')
  check('N6 the nudge stops with the runner', print.includes('idleNudge.stop()'), 'print.ts')
  const q = src('src/input-core/command-queue.ts')
  check('N6 the queue records what it carries at both enqueue doors and reports every consumption', (q.match(/recordQueuedNotice\(stamped\)/g) ?? []).length === 2 && (q.match(/consumeNotices\(queuedNoticeKeys\(/g) ?? []).length === 3 && (q.match(/retireNotices\(queuedNoticeKeys\(/g) ?? []).length === 2, 'command-queue.ts')
  const agent = src('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  check('N6 the agent task records a queued message and its drain', agent.includes('if (queued) recordAgentMessage(taskId, message)') && agent.includes('consumeAgentMessages(taskId)'), 'LocalAgentTask.tsx')
  check('N6 the roster row counts through the ledger', src('src/utils/task/workRoster.ts').includes('unreadNoticesOf(task.id, String(task.agentId))') && src('src/utils/task/workRoster.ts').includes('unreadNoticesOf(task.id, task.identity.agentId)'), 'workRoster.ts')
  check('N6 the crew row paints the owner\'s spelling', src('src/components/mercury-ui/screens/CrewView.tsx').includes('const unread = crewUnreadLabel(facts)') && src('src/components/mercury-ui/screens/CrewView.tsx').includes("{unread !== null ? <Text color={tokens.warning}> · {unread}</Text> : null}"), 'CrewView.tsx')
  const seatWire = src('src/services/engine-connector/seatWire.ts')
  check('N6 the wire tables name the count and the rows', seatWire.includes("unreadNotices: 'unread_notices'") && seatWire.includes('out[noticesKey] = rows(out[noticesKey], t(NOTICE_ROW))'), 'seatWire.ts')
  const docs = src('docs/SESSIONS.md')
  check('N6 the sessions page says what the ledger and the nudge do', docs.includes('MERCURY_NOTICE_DEADLINE_MS') && docs.includes('unread'), 'docs/SESSIONS.md')
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? '✅ unread notices: ALL PASS' : `❌ unread notices: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
