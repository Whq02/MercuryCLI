#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'seat-agent-frames-home-')))
const { onSeatLine } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
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
const roster = { control: () => true, list: () => [], patchSeatModel: () => true }
const published = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))
const tail = () => readSessionTail(sid, dir)
const activity = (): string => JSON.stringify(readSessionWorkers(dir)[SHORT]?.activity ?? null)
let n = 0
const settle = (text: string, parent?: string): string =>
  JSON.stringify({ type: 'assistant', ...(parent !== undefined ? { parent_tool_use_id: parent } : { parent_tool_use_id: null }), message: { id: `msg_${++n}`, content: [{ type: 'text', text }] }, uuid: `u${n}`, session_id: sid })
const result = JSON.stringify({ type: 'result', subtype: 'success' })
const delta = (text: string): string => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

section("§1 a background agent's tagged frame on an idle seat paints nothing in the tail and stamps no activity")
const idleActivity = activity()
onSeatLine(SHORT, settle('the child finished after the handover', 'toolu_agent_1'), roster as never, dir)
await published()
check('the tail stays empty', (tail()?.text ?? null) === null && (tail()?.turnChars ?? 0) === 0, JSON.stringify(tail()))
check('the activity record is untouched', activity() === idleActivity, `${idleActivity} → ${activity()}`)

section("§2 control: the seat's own settle-class reply rides the tail and stamps activity, as today")
onSeatLine(SHORT, settle('Settled whole.'), roster as never, dir)
await published()
check('the tail carries the reply', tail()?.text === 'Settled whole.' && tail()?.turnChars === 'Settled whole.'.length, JSON.stringify(tail()))
check('the activity record moved', activity() !== idleActivity, activity())
onSeatLine(SHORT, result, roster as never, dir)
check('the result clears the tail', (tail()?.text ?? null) === null, JSON.stringify(tail()))

section("§3 a foreground helper's tagged frame during a streaming turn leaves the tail and the activity as they were")
onSeatLine(SHORT, delta('Hello, '), roster as never, dir)
await published()
const streamedTail = JSON.stringify(tail())
const streamedActivity = activity()
await new Promise(resolve => setTimeout(resolve, 5))
onSeatLine(SHORT, settle('a helper spoke', 'toolu_agent_2'), roster as never, dir)
await published()
check('the streamed tail stands unchanged, byte for byte', JSON.stringify(tail()) === streamedTail, `${streamedTail} → ${JSON.stringify(tail())}`)
check('the activity record stands unchanged', activity() === streamedActivity, `${streamedActivity} → ${activity()}`)
onSeatLine(SHORT, result, roster as never, dir)

rmSync(dir, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
