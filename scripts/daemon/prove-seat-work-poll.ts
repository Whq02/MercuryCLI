#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-work-poll-home-'))

const { onSeatRow, onFactsAnswer } = await import('../../src/daemon/sessionSeat.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const dir = mkdtempSync(join(tmpdir(), 'seat-work-poll-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-workpoll0001'
const SHORT = 'concourse-wp1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-wp',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)

const stand = standInRunner()
const roster = stand.roster()
const feed = (row: Record<string, unknown>): void => onSeatRow(SHORT, row as never, roster as never, dir)
const factsRequests = (): number => stand.requests.filter(r => r.method === 'session/facts').length
const answer = (work: unknown[]): Record<string, unknown> =>
  sessionFactsToWire({
    model: { effective: 'claude-opus-5' },
    usage: { totalCostUSD: 0 },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] },
    queue: [],
    work,
    mission: [],
  } as never) as Record<string, unknown>
const landed = (work: unknown[]): void => onFactsAnswer(SHORT, answer(work), roster as never, dir)
const liveRow = { id: 'agent-live', kind: 'agent', name: 'scout', description: 'scout', status: 'running', startTime: Date.now() }
const settledRow = { ...liveRow, status: 'completed', endTime: Date.now() }

console.log('the seat work poll — a settle reaches the facts even when an answer is lost')

console.log('\nW1 an answer with live work arms the poll: a re-ask goes out within the cadence')
{
  landed([liveRow])
  await settle(1300)
  check('one re-ask went out within 1.3 s of the answer', factsRequests() >= 1, `${factsRequests()} request(s)`)
}

console.log('\nW2 NO answer comes back (the runner mid-fold): the cadence continues on its own')
{
  const before = factsRequests()
  await settle(1300)
  check('a further re-ask went out without any answer in between', factsRequests() > before, `${factsRequests() - before} further request(s)`)
}

console.log('\nW3 an answer showing nothing live disarms the poll')
{
  landed([settledRow])
  const at = factsRequests()
  await settle(1500)
  check('no re-ask after the roster settled', factsRequests() === at, `${factsRequests() - at} request(s) after the settle`)
}

console.log("\nW4 the settle's own task row re-asks at once (the row road)")
{
  const at = factsRequests()
  feed({ type: 'task', seq: 1, timestamp: 't', session_id: 'work-poll', state: 'ended', task_id: 'agent-live', status: 'completed', summary: 'scout', output_file: '' })
  await settle(400)
  check('an ended task row re-asked the facts', factsRequests() > at, `${factsRequests() - at} request(s)`)
}

console.log(failures === 0 ? '\n✅ the seat work poll holds' : `\n❌ ${failures} failure(s)`)
stand.close()
process.exit(failures === 0 ? 0 : 1)
