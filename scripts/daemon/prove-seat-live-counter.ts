#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'live-counter-home-'))

const { onSeatLine } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'live-counter-daemon-'))
const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-livecount001'
const SHORT = 'concourse-lc1'
updateConcourseWorkers(workers => {
  workers[SHORT] = {
    schema: 1,
    runnerId: SHORT,
    sessionId: sid,
    workspaceId: 'ws-lc',
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
const ev = (event: Record<string, unknown>): string => JSON.stringify({ type: 'stream_event', event })
const tail = () => readSessionTail(sid, dir)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const cadence = (): Promise<void> => sleep(400)

console.log('the live counter — a think counts, its words never land')
const THINK = 'weighing the ask before answering it'
const PROSE = 'The harbour.'

onSeatLine(SHORT, ev({ type: 'message_start', message: { id: 'msg_lc', usage: {} } }), roster as never, dir)
onSeatLine(SHORT, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), roster as never, dir)
onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK } }), roster as never, dir)
await cadence()
{
  const t = tail()
  check(`C1 a thinking delta raises the count by its length (${THINK.length})`, t?.turnChars === THINK.length, JSON.stringify(t))
  check('C1 the tail text stays clear — a think streams no words', t?.text === null, JSON.stringify(t))
}
onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }), roster as never, dir)
await cadence()
check('C3 an empty thinking delta leaves the count where it was', tail()?.turnChars === THINK.length, JSON.stringify(tail()))
onSeatLine(SHORT, ev({ type: 'content_block_stop', index: 0 }), roster as never, dir)
onSeatLine(SHORT, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), roster as never, dir)
onSeatLine(SHORT, ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: PROSE } }), roster as never, dir)
await cadence()
{
  const t = tail()
  check(`C2 a text delta adds to the same count (${THINK.length + PROSE.length}) and carries its words`, t?.turnChars === THINK.length + PROSE.length && t?.text === PROSE, JSON.stringify(t))
}

console.log(failures === 0 ? '\n✅ seat live counter GREEN' : `\n❌ seat live counter RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
