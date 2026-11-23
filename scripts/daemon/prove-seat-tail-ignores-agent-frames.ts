#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'seat-agent-frames-home-')))
const { onSeatRow } = await import('../../src/daemon/session-seat/sessionSeat.ts')
const { readSessionTail } = await import('../../src/engine/connector/seatProjections.ts')
const { readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = '', hint = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && hint ? ` — change: ${hint}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const dir = mkdtempSync(join(tmpdir(), 'seat-agent-frames-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-agentframes1'
const SHORT = 'concourse-af1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-af',
    isolation: 'exclusive',
    modelKey: 'claude-opus-5',
    effort: 'high',
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
    workspaceKind: 'plain-folder',
  } as never
}, dir)
const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
const published = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const tail = () => readSessionTail(sid, dir)
const activity = (): string => JSON.stringify(readSessionWorkers(dir)[SHORT]?.activity ?? null)
let n = 0
const row = (o: Record<string, unknown>): Record<string, unknown> => ({ seq: 1, timestamp: 't', session_id: sid, turn: 1, ...o })
const settle = (text: string, parent?: string): Record<string, unknown> =>
  row({ type: 'text', ...(parent !== undefined ? { parent_call_id: parent } : {}), message_id: `msg_${++n}`, block: 0, text })
const USAGE = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }
const result = row({ type: 'outcome', schema: 1, turn_id: 't-af', status: 'completed', steps: 1, wall_ms: 1, usage: USAGE, models: [], denials: [] })
const delta = (text: string): Record<string, unknown> => row({ type: 'text_delta', message_id: 'msg_stream', block: 0, text })

section("§1 a background agent's tagged row on an idle seat paints nothing in the tail and stamps no activity")
const idleActivity = activity()
onSeatRow(SHORT, settle('the child finished after the handover', 'toolu_agent_1'), roster as never, dir)
await published()
check('the tail stays empty', (tail()?.text ?? null) === null && (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()), 'onSeatRow in src/daemon/session-seat/rows.ts (the tagged check on row.parent_call_id) must skip a row tagged with parent_call_id on an idle seat')
check('the activity record is untouched', activity() === idleActivity, `${idleActivity} → ${activity()}`, 'onSeatRow in src/daemon/session-seat/rows.ts must not stamp the worker activity for a row tagged with parent_call_id')

section("§2 control: the seat's own settle-class reply rides the tail and stamps activity, as today")
onSeatRow(SHORT, settle('Settled whole.'), roster as never, dir)
await published()
check('the tail carries the reply', tail()?.text === 'Settled whole.' && tail()?.turnChars === 'Settled whole.'.length, JSON.stringify(tail()), 'onSeatRow in src/daemon/session-seat/rows.ts must still put the seat own settled text row in the tail and turnChars')
check('the activity record moved', activity() !== idleActivity, activity(), 'onSeatRow in src/daemon/session-seat/rows.ts must still stamp worker activity for an untagged row')
onSeatRow(SHORT, result, roster as never, dir)
check('the outcome clears the tail', (tail()?.text ?? null) === null, JSON.stringify(tail()), 'onSeatRow in src/daemon/session-seat/rows.ts must clear the tail text on an outcome row')

section("§3 a foreground helper's tagged row during a streaming turn leaves the tail and the activity as they were")
onSeatRow(SHORT, row({ type: 'block_start', message_id: 'msg_stream', block: 0, of: 'text' }), roster as never, dir)
onSeatRow(SHORT, delta('Hello, '), roster as never, dir)
await published()
const streamedTail = JSON.stringify(tail())
const streamedActivity = activity()
await new Promise(resolve => setTimeout(resolve, 5))
onSeatRow(SHORT, settle('a helper spoke', 'toolu_agent_2'), roster as never, dir)
await published()
check('the streamed tail stands unchanged, byte for byte', JSON.stringify(tail()) === streamedTail, `${streamedTail} → ${JSON.stringify(tail())}`, 'onSeatRow in src/daemon/session-seat/rows.ts must ignore a tagged settle row while the seat streams, so the tail text and turnChars stay as streamed')
check('the activity record stands unchanged', activity() === streamedActivity, `${streamedActivity} → ${activity()}`, 'onSeatRow in src/daemon/session-seat/rows.ts must not stamp worker activity for a row tagged with parent_call_id during a stream')
onSeatRow(SHORT, result, roster as never, dir)

rmSync(dir, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
