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
const { partialRowsOf, itemRowsOf, stepRow } = await import('../../src/rows/project.ts')
const scope = { session_id: sid, turn: 1 }
const stamp = (o: Record<string, unknown>): string => JSON.stringify({ seq: 1, timestamp: 't', ...o })
const feed = (lines: Array<Record<string, unknown>>): void => {
  for (const line of lines) onSeatLine(SHORT, stamp(line), roster as never, dir)
}
const ev = (messageId: string, event: Record<string, unknown>): void => feed(partialRowsOf(scope, messageId, event as never) as never)
const tail = () => readSessionTail(sid, dir)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const cadence = (): Promise<void> => sleep(400)
const USAGE = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }

console.log('the live counter — a think counts, its words never land')
const THINK = 'weighing the ask before answering it'
const PROSE = 'The harbour.'

ev('msg_lc', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
ev('msg_lc', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK } })
await cadence()
{
  const t = tail()
  check(`C1 a reasoning delta raises the count by its length (${THINK.length})`, t?.turnChars === THINK.length, JSON.stringify(t))
  check('C1 the tail text stays clear — a think streams no words', t?.text === null, JSON.stringify(t))
}
ev('msg_lc', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } })
await cadence()
check('C3 an empty reasoning delta leaves the count where it was', tail()?.turnChars === THINK.length, JSON.stringify(tail()))
ev('msg_lc', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
ev('msg_lc', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: PROSE } })
await cadence()
{
  const t = tail()
  check(`C2 a text delta adds to the same count (${THINK.length + PROSE.length}) and carries its words`, t?.turnChars === THINK.length + PROSE.length && t?.text === PROSE, JSON.stringify(t))
}

let expected = THINK.length + PROSE.length
for (const type of ['tool_use', 'server_tool_use', 'mcp_tool_use']) {
  ev('msg_lc', { type: 'content_block_start', index: 2, content_block: { type, id: 'call_input', name: 'Write', input: {} } })
  check(`${type}: an empty input seed adds no characters`, tail()?.turnChars === expected)
  const parts = ['{"content":"', 'the tool input '.repeat(500), '"}']
  for (const partial_json of parts) {
    ev('msg_lc', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json } })
    expected += partial_json.length
  }
  await cadence()
  check(`${type}: every input fragment adds its length to the same count`, tail()?.turnChars === expected, JSON.stringify(tail()))
  check(`${type}: input never appears as assistant prose (the tail keeps the streamed words)`, tail()?.text === PROSE, JSON.stringify(tail()?.text))
}
for (const input of [{ content: 'already supplied' }]) {
  ev('msg_lc', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_seed', name: 'Write', input } })
  expected += JSON.stringify(input).length
  check('nonempty input on the block start counts once', tail()?.turnChars === expected, JSON.stringify(tail()))
}
for (const partial_json of ['', null, 7]) {
  ev('msg_lc', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json } })
}
await cadence()
check('empty and malformed input fragments change no count', tail()?.turnChars === expected)
feed(itemRowsOf(scope, 'msg_lc', [{ type: 'tool_use', id: 'call_input', name: 'Write', input: { content: 'the tool input' } }]) as never)
check('the settled tool call does not count its input a second time', tail()?.turnChars === expected)
feed([stepRow(scope, { messageId: 'msg_lc', model: 'm', stopReason: 'tool_use', usage: USAGE }) as never])
check('the step does not reset the in-flight turn', tail()?.turnChars === expected)
feed([{ type: 'outcome', session_id: sid, turn: 1, schema: 1, turn_id: 't-lc', status: 'completed', steps: 1, wall_ms: 1, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }, models: [], denials: [] }])
check('the outcome clears the full count', (tail()?.turnChars ?? 0) === 0)

console.log(failures === 0 ? '\n✅ seat live counter GREEN' : `\n❌ seat live counter RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
