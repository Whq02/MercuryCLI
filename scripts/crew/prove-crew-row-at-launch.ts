#!/usr/bin/env bun
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, sleep, TURN_MS } from './crew-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { crewAgentFactsOf, crewStateLabel, crewTokensLabel } = await import('../../src/services/engine-connector/crewFacts.ts')
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1

const FIRST = 'START-HARBOUR'
const AGENT_WORK = 'HARBOUR-WORK'
const AGENT_REPLY = 'HARBOUR-COUNTED'
const LAUNCH_ID = 'toolu_harbour_launch'
const HOLD_MS = 6000
const tally = makeTally('prove-crew-row-at-launch')

const lead = (turn: Record<string, unknown>): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: FIRST }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({
    kind: 'tool_use',
    id: LAUNCH_ID,
    name: 'Agent',
    input: { description: 'count the harbour', prompt: `${AGENT_WORK}: count the boats and reply once.`, subagent_type: 'mercury-crew' },
  }),
  { kind: 'stream', blocks: [{ type: 'text', deltas: [AGENT_REPLY] }], gapMs: 0, headerDelayMs: HOLD_MS, whenBody: AGENT_WORK },
  lead({ kind: 'text', text: 'LEAD-DONE' }),
]

type Row = { type?: string; state?: string; task_id?: string; description?: string; status?: string; parent_call_id?: string; role?: string; call_id?: string; name?: string }
const rowsOf = (frames: readonly Record<string, unknown>[]): Row[] => frames as Row[]
const taskStarted = (rows: Row[]): Row | undefined => rows.find(r => r.type === 'task' && r.state === 'started' && r.description === 'count the harbour')
const agentReplyAt = (rows: Row[]): number => rows.findIndex(r => JSON.stringify(r).includes(AGENT_REPLY) && r.type !== 'task')
const agentRequestSeen = (world: Awaited<ReturnType<typeof makeWorld>>): boolean =>
  world.fixture.messageRequests().some(request => JSON.stringify(request.body ?? null).includes(AGENT_WORK) && !JSON.stringify(request.body ?? null).includes(FIRST))

tally.section('L1 — the drive: the agent is on the wire while its first reply is still held')
const world = await makeWorld('crew-row-at-launch', script)
const session = bootLead(world, [], ['Agent'])
let startedWhileHeld: Row | undefined
let rowsAtLaunch = 0
try {
  session.submit(`${FIRST}: count the harbour with one agent.`)
  await session.waitFor('the agent never asked the fixture for its first reply', () => agentRequestSeen(world), TURN_MS)
  const askedAt = Date.now()
  while (Date.now() - askedAt < HOLD_MS / 3) {
    startedWhileHeld = taskStarted(rowsOf(session.frames))
    if (startedWhileHeld !== undefined) break
    await sleep(50)
  }
  rowsAtLaunch = session.frames.length
  tally.check(
    'RED ON THE BASE: the `task started` row for the launched agent is on the wire while its first reply is held',
    startedWhileHeld !== undefined,
    `after ${Math.round((Date.now() - askedAt) / 1000)}s of the ${HOLD_MS / 1000}s hold the wire carried ${session.frames.length} rows and no task started row for "count the harbour"`,
  )
  tally.check('…and the held reply has not landed yet (the hold is real)', agentReplyAt(rowsOf(session.frames)) === -1, `reply index ${agentReplyAt(rowsOf(session.frames))}`)

  await session.waitFor('the lead never finished the turn', () => session.stdout().includes('LEAD-DONE'), TURN_MS)
  const rows = rowsOf(session.frames)

  tally.section('L2 — the order on the wire')
  const started = rows.findIndex(r => r.type === 'task' && r.state === 'started' && r.description === 'count the harbour')
  const launch = rows.findIndex(r => JSON.stringify(r).includes(LAUNCH_ID) && r.type !== 'task')
  const reply = agentReplyAt(rows)
  tally.check('the task started row lands once', rows.filter(r => r.type === 'task' && r.state === 'started' && r.description === 'count the harbour').length === 1)
  tally.check('…after the lead\'s launching tool_use row', launch >= 0 && started > launch, `launch ${launch} started ${started}`)
  tally.check('…and before the agent\'s first assistant row', reply >= 0 && started < reply, `started ${started} reply ${reply}`)
  tally.check('…inside the rows that were on the wire during the hold', started >= 0 && started < rowsAtLaunch, `started ${started} rows at launch ${rowsAtLaunch}`)

  tally.section('L3 — the ended row still lands once, after the reply')
  const ended = rows.filter(r => r.type === 'task' && r.state === 'ended' && r.task_id === (startedWhileHeld?.task_id ?? rows[started]?.task_id))
  tally.check('one ended row for the agent', ended.length === 1, `${ended.length} ended rows`)
  tally.check('…after the reply', ended.length === 1 && rows.indexOf(ended[0]!) > reply, `ended ${rows.indexOf(ended[0]!)} reply ${reply}`)
  tally.check('…with the completed status', ended[0]?.status === 'completed', String(ended[0]?.status))
} finally {
  await session.end()
  await closeWorld(world)
}

tally.section('L4 — the rail\'s row for the launched-but-unanswered phase needs no new word')
{
  const row = { id: 'agent-1', kind: 'agent', name: 'count the harbour', status: 'running', startTime: Date.now() } as WorkRow
  const facts = crewAgentFactsOf(row, 'lead')
  tally.check('a running record with no settled response has no tokens label (no fabricated zero)', facts !== null && crewTokensLabel(facts) === null)
  tally.check('…and its one status word is running — the verb the rail paints for that phase', facts !== null && crewStateLabel(facts) === 'running', String(facts === null ? null : crewStateLabel(facts)))
}

tally.finish()
