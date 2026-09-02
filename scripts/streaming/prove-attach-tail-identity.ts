#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tailid-home-'))

const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

type TimerFn = () => void
const pending: TimerFn[] = []
const timers = {
  setTimer: (fn: TimerFn) => {
    pending.push(fn)
    return fn
  },
  clearTimer: (h: unknown) => {
    const i = pending.indexOf(h as TimerFn)
    if (i >= 0) pending.splice(i, 1)
  },
  now: () => 0,
}

console.log('attach tail identity — one message, one painted instance')

console.log('\n§1 the store id channel moves with the text transitions')
try {
  const store = createStreamingTailStore(timers)
  const ids = () => (store as unknown as { readIds(): { current: string | null; settled: string | null } }).readIds()
  const stage = (id: string | null) => (store as unknown as { setMessageId(id: string | null): void }).setMessageId(id)

  stage('msg_A')
  store.update(() => 'Hello')
  check('text takes the staged id as CURRENT', ids().current === 'msg_A', JSON.stringify(ids()))
  check('no settled id while text stands', ids().settled === null, JSON.stringify(ids()))
  store.update(() => 'Hello, operator')
  check('growth keeps the id', ids().current === 'msg_A', JSON.stringify(ids()))
  store.update(() => null)
  check('the clear slides the id into the SETTLED hold with the text', ids().settled === 'msg_A', JSON.stringify(ids()))
  check('…and the ghost text is the retired text', store.readSettled() === 'Hello, operator')
  check('…and current clears with the text', ids().current === null, JSON.stringify(ids()))
  stage('msg_B')
  store.update(() => 'Next block')
  check('next text drops the settled id with the ghost', ids().settled === null && ids().current === 'msg_B', JSON.stringify(ids()))
  store.update(() => null)
  store.dropSettled()
  check('dropSettled clears the settled id with the ghost', ids().settled === null && store.readSettled() === null, JSON.stringify(ids()))
  stage('msg_C')
  store.reset('reset text')
  check('reset(non-null) takes the staged id', ids().current === 'msg_C', JSON.stringify(ids()))
  store.reset(null)
  check('reset(null) slides like the clear', ids().settled === 'msg_C', JSON.stringify(ids()))
  const bare = createStreamingTailStore(timers)
  bare.update(() => 'in-process text')
  bare.update(() => null)
  const bareIds = (bare as unknown as { readIds(): { current: string | null; settled: string | null } }).readIds()
  check('a writer that never stages an id keeps every id null (in-process world unchanged)', bareIds.current === null && bareIds.settled === null, JSON.stringify(bareIds))
} catch (e) {
  check('the id channel exists on the store', false, String(e))
}

console.log('\n§2 the release law: identity retires where text-matching cannot')
const FULL = 'No Playwright, but Chrome is installed locally — I’ll use headless Chrome plus a Node harness approach.'
const PREFIX = 'No Playwright, but Chrome is installed locally — I’ll use headless Chrome plus a Node har'
type Row = Record<string, unknown>
const userRow: Row = {
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-08-31T18:44:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'check the browser story' }] },
}
const assistantTextRow = (id: string | null, text: string, uuid: string): Row => ({
  type: 'assistant',
  uuid,
  timestamp: '2026-08-31T18:45:10.000Z',
  message: { ...(id !== null ? { id } : {}), role: 'assistant', content: [{ type: 'text', text }], model: 'x' },
})
const toolResultRow: Row = {
  type: 'user',
  uuid: 'u-2',
  timestamp: '2026-08-31T18:45:12.000Z',
  toolUseResult: { ok: true },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] },
}
try {
  const { computeTailRelease } = await import('../../src/utils/messages/tailRetirement.ts')
  const rows = [userRow, assistantTextRow('msg_X', FULL, 'a-1'), toolResultRow]

  const sighting = computeTailRelease(rows as never, { current: null, settled: 'msg_X' }, PREFIX)
  check('THE SIGHTING HEALS: the stale mid-word prefix ghost retires by identity beside its row', sighting.settledShown === true, JSON.stringify(sighting))

  const oldRunner = computeTailRelease(rows as never, { current: null, settled: null }, PREFIX)
  check('CONTROL (the disease, documented): with no id the text fallback CANNOT release the stale prefix', oldRunner.settledShown === false, JSON.stringify(oldRunner))

  const exact = computeTailRelease(rows as never, { current: null, settled: null }, `  ${FULL}\n`)
  check('the fallback still releases an exact settle (both sides trimmed — today’s law kept)', exact.settledShown === true, JSON.stringify(exact))

  const held = computeTailRelease(rows as never, { current: 'msg_X', settled: null }, null)
  check('the settle-class PUBLISHED hold retires the instant its row is visible', held.publishedShown === true, JSON.stringify(held))

  const streamingStill = computeTailRelease([userRow] as never, { current: 'msg_X', settled: null }, null)
  check('…and NEVER before the row lands (live streaming untouched)', streamingStill.publishedShown === false, JSON.stringify(streamingStill))

  const behindHuman = computeTailRelease(
    [assistantTextRow('msg_X', FULL, 'a-0'), userRow] as never,
    { current: 'msg_X', settled: 'msg_X' },
    PREFIX,
  )
  check('the walk stops at the human-turn boundary (an older turn’s row never releases)', behindHuman.publishedShown === false && behindHuman.settledShown === false, JSON.stringify(behindHuman))

  const acrossToolResult = computeTailRelease(
    [userRow, assistantTextRow('msg_X', FULL, 'a-1'), toolResultRow, assistantTextRow('msg_Y', 'tool follow-up', 'a-2')] as never,
    { current: null, settled: 'msg_X' },
    PREFIX,
  )
  check('a tool_result user row does not break the walk', acrossToolResult.settledShown === true, JSON.stringify(acrossToolResult))
} catch (e) {
  check('the one release law exists (src/utils/messages/tailRetirement.ts)', false, String(e))
}

console.log('\n§3 the seat stamps the provider message id into the tail file')
try {
  const { onSeatLine, onSeatSpawned } = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

  const dir = mkdtempSync(join(tmpdir(), 'tailid-daemon-'))
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-tailidentity'
  const SHORT = 'concourse-ti1'
  updateConcourseWorkers(workers => {
    workers[SHORT] = {
      schema: 1,
      runnerId: SHORT,
      sessionId: sid,
      workspaceId: 'ws-ti',
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
  const frame = (o: unknown): string => JSON.stringify(o)

  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_live', usage: {} } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Empty directory apart ' } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'from the harness.' } } }), roster as never, dir)
  await published()
  check('streamed text publishes WITH the message_start id', tail()?.messageId === 'msg_live', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_stop' } }), roster as never, dir)
  check('the clear keeps the id — the ghost’s identity', tail()?.text === null && tail()?.messageId === 'msg_live', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'result', subtype: 'success' }), roster as never, dir)
  check('the result frame zeroes the id with the turn', (tail()?.messageId ?? null) === null, JSON.stringify(tail()))

  onSeatLine(SHORT, frame({ type: 'assistant', message: { id: 'msg_settle', content: [{ type: 'text', text: 'Settled whole.' }] } }), roster as never, dir)
  check('a settle-class frame stamps its own id beside its held text', tail()?.text === 'Settled whole.' && tail()?.messageId === 'msg_settle', JSON.stringify(tail()))

  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_next', usage: {} } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fresh stream.' } } }), roster as never, dir)
  await published()
  check('message_start clears a held tail — the new stream never concatenates onto it', tail()?.text === 'Fresh stream.' && tail()?.messageId === 'msg_next', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'result', subtype: 'success' }), roster as never, dir)

  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_dead', usage: {} } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half a turn' } } }), roster as never, dir)
  onSeatSpawned(SHORT, roster as never, dir)
  check('a respawn zeroes the id with the tail', (tail()?.messageId ?? null) === null, JSON.stringify(tail()))
} catch (e) {
  check('the seat stamps identity', false, String(e))
}

console.log('\n§4 the connector stages the id and detach drops the ghost')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check('readTail stages the file’s id into the store before every feed', src.includes('setMessageId'), 'no setMessageId call in daemonConnector.ts')
  check('detach drops the ghost with the tail (a moment, never a cache)', src.includes('dropSettled'), 'no dropSettled call in daemonConnector.ts')
  try {
    const store = createStreamingTailStore(timers)
    const stage = (id: string | null) => (store as unknown as { setMessageId(id: string | null): void }).setMessageId(id)
    stage('msg_D')
    store.update(() => 'mid-stream text the hop leaves behind')
    store.reset(null)
    store.dropSettled()
    stage(null)
    check('the detach sequence leaves NO ghost for the next attach to paint stale', store.readSettled() === null && store.read() === null)
  } catch (e) {
    check('the detach sequence leaves no ghost', false, String(e))
  }
}

console.log('\n§5 the screen routes its release through the one law')
{
  const messages = readFileSync(join(import.meta.dir, '..', '..', 'src/components/Messages.tsx'), 'utf8')
  check('Messages computes the release through computeTailRelease', messages.includes('computeTailRelease'), 'no computeTailRelease in Messages.tsx')
  check('Messages hands publishedShown down', messages.includes('publishedShown'), 'no publishedShown in Messages.tsx')
  const leaf = readFileSync(join(import.meta.dir, '..', '..', 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('LiveStreamingTail hides published text behind the release', leaf.includes('publishedShown'), 'no publishedShown in LiveStreamingTail.tsx')
}

console.log(
  failures === 0
    ? '\n ✅ ATTACH TAIL IDENTITY — one message, one painted instance, whatever the road in'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
