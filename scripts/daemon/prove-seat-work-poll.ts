#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-work-poll-home-'))

const { onSeatLine, SESSION_FACTS_REQUEST_PREFIX } = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
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

const requests: string[] = []
const roster = { control: (_short: string, frame: string) => { requests.push(frame); return true }, list: () => [], patchSeatModel: () => true }
const feed = (line: string): void => onSeatLine(SHORT, line, roster as never, dir)
const factsRequests = (): number => requests.filter(f => f.includes('"session_facts"')).length
let seq = 0
const answer = (work: unknown[]): string =>
  JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: `${SESSION_FACTS_REQUEST_PREFIX}${SHORT}-${++seq}`,
      response: sessionFactsToWire({
        model: { effective: 'claude-opus-5' },
        usage: { totalCostUSD: 0 },
        skills: [],
        mcp: [],
        permissionMode: 'default',
        workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] },
        queue: [],
        work,
        mission: [],
      } as never),
    },
  })
const liveRow = { id: 'agent-live', kind: 'agent', name: 'scout', description: 'scout', status: 'running', startTime: Date.now() }
const settledRow = { ...liveRow, status: 'completed', endTime: Date.now() }

console.log('the seat work poll — a settle reaches the facts even when an answer is lost')

console.log('\nW1 an answer with live work arms the poll: a re-ask goes out within the cadence')
{
  feed(answer([liveRow]))
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
  feed(answer([settledRow]))
  const at = factsRequests()
  await settle(1500)
  check('no re-ask after the roster settled', factsRequests() === at, `${factsRequests() - at} request(s) after the settle`)
}

console.log("\nW4 the settle's own frame re-asks at once (the frame road)")
{
  const at = factsRequests()
  feed(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'agent-live', status: 'completed', summary: 'scout', output_file: '' }))
  await settle(400)
  check('a task_notification frame re-asked the facts', factsRequests() > at, `${factsRequests() - at} request(s)`)
}

console.log(failures === 0 ? '\n✅ the seat work poll holds' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
