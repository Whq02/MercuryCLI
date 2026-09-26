#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'facts-stamp-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { sessionFactsToWire } = await import('../../src/services/engine-connector/seatWire.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(" two publications of a seat's facts in one clock tick are told apart by their stamps")
console.log('============================================================')

const dir = mkdtempSync(join(tmpdir(), 'facts-stamp-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-factsstamp01'
const SHORT = 'concourse-fs1'
const cwd = join(dir, 'fixture-repo')
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: cwd,
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = {
  control: () => true,
  list: () => [{ short: SHORT, turnActive: false }],
  patchSeatModel: () => true,
  patchSeatEffort: () => true,
}
const facts = () => readSessionFacts(sid, dir)
const realNow = Date.now
const holdClock = (at: number): void => {
  Date.now = () => at
}
const freeClock = (): void => {
  Date.now = realNow
}
let factsSeq = 0
const runnerFacts = (costUSD: number): void => {
  const answer = {
    model: { effective: 'claude-opus-5', setting: 'claude-opus-5' },
    usage: { totalCostUSD: costUSD, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd, originalCwd: cwd, projectRoot: cwd, instructionRoots: [] },
    queue: [],
  }
  factsSeq += 1
  seat.onSeatLine(SHORT, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: `mercury-session-facts-${SHORT}-${factsSeq}`, response: sessionFactsToWire(answer as never) } }), roster as never, dir)
}

section("S1 · two of the seat's own publications in one clock tick carry distinct stamps, the later one greater")
const t0 = realNow()
holdClock(t0)
seat.publishSeatFacts(SHORT, dir, roster as never)
const first = facts()?.atMs
seat.publishSeatFacts(SHORT, dir, roster as never)
const second = facts()?.atMs
freeClock()
check('the first publication carries the clock', first === t0, `first=${first} clock=${t0}`)
check('the second, in the same tick, carries a later stamp', first !== undefined && second !== undefined && second > first, `first=${first} second=${second}`)

section("S2 · the runner's answer landing in the tick of a seat publish is told apart from it (the landing road)")
const t1 = t0 + 5
holdClock(t1)
seat.publishSeatFacts(SHORT, dir, roster as never)
const landing = facts()
runnerFacts(0.5)
const fresh = facts()
freeClock()
check('the seat publish carries the clock, past the tick before', landing?.atMs === t1, `atMs=${landing?.atMs} clock=${t1}`)
check("the runner's answer is the row on disk (its usage figure stands)", fresh?.usage.totalCostUSD === 0.5, JSON.stringify(fresh?.usage))
check("…with a stamp later than the seat publish's, though the clock did not move", (fresh?.atMs ?? 0) > (landing?.atMs ?? 0), `landing=${landing?.atMs} fresh=${fresh?.atMs}`)

section('S3 · a burst in one tick lands newest-last with strictly rising stamps, and the clock takes over once it moves on')
const t2 = t1 + 10
holdClock(t2)
const stamps: number[] = []
for (let i = 1; i <= 5; i++) {
  runnerFacts(1 + i / 10)
  stamps.push(facts()?.atMs ?? 0)
}
freeClock()
check('five stamps rise strictly', stamps.every((s, i) => i === 0 || s > (stamps[i - 1] ?? Number.POSITIVE_INFINITY)), stamps.join(','))
check('the first of the burst carries the clock', stamps[0] === t2, `first=${stamps[0]} clock=${t2}`)
check('the last publication is the row on disk', facts()?.usage.totalCostUSD === 1.5, JSON.stringify(facts()?.usage))
const t3 = t2 + 10_000
holdClock(t3)
runnerFacts(2)
const late = facts()?.atMs
freeClock()
check("once the clock has moved past the burst, the stamp is the clock's word again", late === t3, `atMs=${late} clock=${t3}`)

console.log(failures === 0 ? '\nprove-facts-stamp-order: ALL LAWS HOLD' : `\nprove-facts-stamp-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
