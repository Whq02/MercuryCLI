#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'activity-home-'))
const dir = mkdtempSync(join(tmpdir(), 'activity-store-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')
import type { WorkRowV1 } from '../../src/services/engine-connector/types.ts'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

let checks = 0
function check(label: string, value: unknown): void {
  assert(value, label)
  checks++
  console.log(`PASS ${label}`)
}
const short = 'concourse-w1'
let active = false
const roster = {
  list: () => [{ short, turnActive: active, busy: active }],
  control: () => true,
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const feed = (frame: object): void => seat.onSeatLine(short, JSON.stringify(frame), roster, dir)
let sequence = 0
const facts = (work: WorkRowV1[]): void => feed({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: `${seat.SESSION_FACTS_REQUEST_PREFIX}${short}-${++sequence}`,
    response: sessionFactsToWire({
      model: { effective: 'claude-sonnet-5', setting: null },
      usage: { totalCostUSD: 0 },
      identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
      skills: [], mcp: [], permissionMode: 'default',
      workspace: { cwd: home, originalCwd: home, projectRoot: home, instructionRoots: [] },
      queue: [], work, mission: [],
    } as never),
  },
})
const agent = (id: string, status = 'running'): WorkRowV1 => ({ id, kind: 'agent', name: id, status, startTime: 100 })
const disk = () => JSON.parse(readFileSync(supervisor.concourseWorkersPath(dir), 'utf8')).workers[short] as ConcourseWorkerRecordV1
const realNow = Date.now
let now = 1000
Date.now = () => now
try {
  supervisor.updateConcourseWorkers(workers => {
    workers[short] = { schema: 1, runnerId: short, sessionId: 'activity-fixture', workspaceId: home, isolation: 'shared', modelKey: 'claude-sonnet-5', spawnedAt: now, lastLiveAt: now }
  }, dir)
  check('a new record is idle with no invented last turn', disk().activity?.state === 'idle' && disk().activity?.lastTurnAt === null)
  active = true
  supervisor.markConcourseWorkerDelivery(short, dir)
  check('delivery records working before any response', disk().activity?.state === 'working' && disk().activity?.lastTurnAt === null)
  facts([agent('first'), agent('nested')])
  check('a working parent with two children is still working', disk().activity?.state === 'working' && disk().activity?.subagents === 2)
  now = 2000
  feed({ type: 'assistant', message: { id: 'response-one', content: [{ type: 'text', text: 'The work continues.' }] } })
  check('the assistant response records the actual last-turn time', disk().activity?.lastTurnAt === 2000)
  now = 3000
  facts([agent('first'), agent('nested')])
  feed({ type: 'system', subtype: 'status', status: { waiting_on_agents: 2 } })
  check('an explicit child wait records its count and readable wording', disk().activity?.state === 'waiting' && disk().activity?.description === 'waiting on 2 sub-agents')
  check('facts and wait messages do not advance the model-turn clock', disk().activity?.lastTurnAt === 2000)
  now = 4000
  active = false
  feed({ type: 'result', result: 'waiting for children' })
  supervisor.markConcourseWorkerTurnSettled(short, dir)
  seat.onSeatIdle(short, roster, dir)
  check('a completed parent turn cannot hide running children as idle', disk().activity?.state === 'waiting' && disk().activity?.subagents === 2)
  check('the completed turn updates the clock', disk().activity?.lastTurnAt === 4000)
  now = 5000
  facts([agent('first', 'completed'), agent('nested')])
  check('a background completion reduces the count without a parent turn', disk().activity?.description === 'waiting on 1 sub-agent' && disk().activity?.lastTurnAt === 4000)
  facts([agent('first', 'completed'), agent('nested', 'failed')])
  check('only settled work is idle and retains the last-turn time', disk().activity?.state === 'idle' && disk().activity?.subagents === 0 && disk().activity?.lastTurnAt === 4000)
  facts([{ id: 'workflow', kind: 'workflow', name: 'workflow', status: 'running', startTime: 100, agentCount: 8, pulse: { running: 3, settled: 5, maxAttempt: 1, lastEventAt: now } }])
  check('workflow children use the live count, not the lifetime total', disk().activity?.state === 'waiting' && disk().activity?.subagents === 3)
  facts([{ id: 'shell', kind: 'shell', name: 'check', status: 'running', startTime: 100 }])
  check('a running shell is working, not an invented sub-agent', disk().activity?.state === 'working' && disk().activity?.subagents === 0)
  facts([agent('paused', 'paused')])
  check('paused and finished agents do not count as running', disk().activity?.state === 'idle')
  const previous = disk().activity
  feed({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated', response: { text: 'assistant' } } })
  assert.deepEqual(disk().activity, previous)
  check('unrelated control traffic does not invent another turn', disk().activity?.lastTurnAt === 4000)
  check('an older runner can report an explicit count without a work roster', supervisor.sessionActivityOf(true, undefined, 4, 700).description === 'waiting on 4 sub-agents')
  facts([agent('remaining')])
  supervisor.updateConcourseWorkers(workers => { workers[short]!.crash = { at: now, reason: 'process ended', respawning: false } }, dir)
  check('a dead process cannot retain running activity', disk().activity?.state === 'idle' && disk().crash?.reason === 'process ended')
  supervisor.updateConcourseWorkers(workers => { delete workers[short]!.crash; workers[short]!.endedAt = now }, dir)
  supervisor.markConcourseWorkerActivity(short, { turnActive: true, lastTurnAt: 9000 }, dir)
  check('late activity cannot reopen an ended record', disk().activity?.state === 'idle' && disk().activity?.lastTurnAt === 4000)
  seat.onSeatSettled(short)
  check('the state survives the in-memory observer being retired', disk().activity?.lastTurnAt === 4000)
  console.log(`Session activity: ${checks} checks passed`)
} finally {
  Date.now = realNow
  seat.onSeatSettled(short)
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}
