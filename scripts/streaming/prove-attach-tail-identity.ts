#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeOnlyText } from '../lib/codeText.ts'

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

  const labelled = createStreamingTailStore(timers)
  labelled.setPhase('commentary')
  labelled.update(() => 'a working note')
  check('text takes the staged register as CURRENT', labelled.readPhases().current === 'commentary', JSON.stringify(labelled.readPhases()))
  labelled.update(() => null)
  check('the clear slides the register into the SETTLED hold beside the ghost', labelled.readPhases().settled === 'commentary' && labelled.readPhases().current === null, JSON.stringify(labelled.readPhases()))
  check('…and stamps the ghost\'s birth on the store\'s clock', typeof labelled.readSettledSinceMs() === 'number', String(labelled.readSettledSinceMs()))
  labelled.setPhase(null)
  labelled.update(() => 'the answer')
  check('the next (unlabelled) text drops the settled register with the ghost and its stamp', labelled.readPhases().settled === null && labelled.readPhases().current === null && labelled.readSettledSinceMs() === null, JSON.stringify(labelled.readPhases()))
  labelled.update(() => null)
  labelled.dropSettled()
  check('dropSettled clears the register and the stamp with the ghost', labelled.readPhases().settled === null && labelled.readSettledSinceMs() === null)
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

  const sighting = computeTailRelease(rows as never, { current: null, settled: 'msg_X' })
  check('THE SIGHTING HEALS: the stale mid-word prefix ghost retires by identity beside its row', sighting.settledShown === true, JSON.stringify(sighting))

  const queuedRow = (uuid: string, text: string): Row => ({
    type: 'user',
    uuid,
    timestamp: '2026-08-31T18:45:11.000Z',
    queued: true,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  const underQueued = computeTailRelease(
    [userRow, assistantTextRow('msg_X', FULL, 'a-1'), queuedRow('q-1', 'first queued words'), queuedRow('q-2', 'second queued words')] as never,
    { current: null, settled: 'msg_X' },
  )
  check('THE QUEUED SHAPE HEALS: a ghost whose row stands above two queued user rows retires (no row bounds the walk)', underQueued.settledShown === true, JSON.stringify(underQueued))

  const behindHuman = computeTailRelease(
    [assistantTextRow('msg_X', FULL, 'a-0'), userRow] as never,
    { current: 'msg_X', settled: 'msg_X' },
  )
  check('an id is exact: a row behind a sent human turn still retires by identity (the drained queue is the next turn\'s ask)', behindHuman.publishedShown === true && behindHuman.settledShown === true, JSON.stringify(behindHuman))

  const noIdentity = computeTailRelease(rows as never, { current: null, settled: null })
  check('CONTROL: with no identity nothing releases — not even an exact text (the text match is retired; the ghost\'s own linger retires it)', noIdentity.settledShown === false && noIdentity.publishedShown === false, JSON.stringify(noIdentity))

  const held = computeTailRelease(rows as never, { current: 'msg_X', settled: null })
  check('the settle-class PUBLISHED hold retires the instant its row is visible', held.publishedShown === true, JSON.stringify(held))

  const streamingStill = computeTailRelease([userRow] as never, { current: 'msg_X', settled: null })
  check('…and NEVER before the row lands (live streaming untouched)', streamingStill.publishedShown === false, JSON.stringify(streamingStill))

  const acrossToolResult = computeTailRelease(
    [userRow, assistantTextRow('msg_X', FULL, 'a-1'), toolResultRow, assistantTextRow('msg_Y', 'tool follow-up', 'a-2')] as never,
    { current: null, settled: 'msg_X' },
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
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', phase: 'commentary' } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Empty directory apart ' } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'from the harness.' } } }), roster as never, dir)
  await published()
  check('streamed text publishes WITH the message_start id', tail()?.messageId === 'msg_live', JSON.stringify(tail()))
  check('…and WITH the block\'s register from its start frame (a working note)', tail()?.phase === 'commentary', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_stop' } }), roster as never, dir)
  check('the clear keeps the id — the ghost’s identity', tail()?.text === null && tail()?.messageId === 'msg_live', JSON.stringify(tail()))
  check('…and keeps the register — the ghost\'s ink', tail()?.phase === 'commentary', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'result', subtype: 'success' }), roster as never, dir)
  check('the result frame zeroes the id with the turn', (tail()?.messageId ?? null) === null, JSON.stringify(tail()))
  check('…and the register', (tail()?.phase ?? null) === null, JSON.stringify(tail()))

  onSeatLine(SHORT, frame({ type: 'assistant', message: { id: 'msg_settle', content: [{ type: 'text', text: 'Settled whole.', phase: 'final_answer' }] } }), roster as never, dir)
  check('a settle-class frame stamps its own id beside its held text', tail()?.text === 'Settled whole.' && tail()?.messageId === 'msg_settle', JSON.stringify(tail()))
  check('…and its text block\'s register', tail()?.phase === 'final_answer', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_plain', usage: {} } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }), roster as never, dir)
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'plain words' } } }), roster as never, dir)
  await published()
  check('an unlabelled text block publishes no register (assign-or-null, never inherited)', tail()?.text === 'plain words' && (tail()?.phase ?? null) === null, JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'result', subtype: 'success' }), roster as never, dir)

  onSeatLine(SHORT, frame({ type: 'assistant', message: { id: 'msg_held', content: [{ type: 'text', text: 'Held settle text.', phase: 'final_answer' }] } }), roster as never, dir)
  check('fixture: a NON-EMPTY settle-class tail is held immediately before the next message_start (no result frame in between)', tail()?.text === 'Held settle text.' && tail()?.messageId === 'msg_held', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_next', usage: {} } } }), roster as never, dir)
  check('message_start on a held tail clears it under the NEW identity before any delta', tail()?.text === null && tail()?.messageId === 'msg_next', JSON.stringify(tail()))
  onSeatLine(SHORT, frame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fresh stream.' } } }), roster as never, dir)
  await published()
  check('message_start clears a held tail — the new stream never concatenates onto it', tail()?.text === 'Fresh stream.' && tail()?.messageId === 'msg_next', JSON.stringify(tail()))
  check('…the held words are gone from the tail, not merely prefixed', !(tail()?.text ?? '').includes('Held settle text.'), JSON.stringify(tail()))
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
  const src = codeOnlyText('daemonConnector.ts', readFileSync(join(import.meta.dir, '..', '..', 'src/services/engine-connector/daemonConnector.ts'), 'utf8'))
  const method = (name: string): string => {
    const at = src.search(new RegExp(`\\n  (?:private |public )?${name}\\(\\): void \\{`))
    if (at === -1) return ''
    const open = src.indexOf('{', src.indexOf(`${name}(`, at))
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
    }
    return ''
  }
  const readTail = method('readTail')
  const detach = method('detach')
  check('readTail is a bounded method', readTail.length > 0, 'no readTail(): void method found')
  const idAt = readTail.indexOf('this.tailStore.setMessageId(')
  const phaseAt = readTail.indexOf('this.tailStore.setPhase(')
  const feedAt = readTail.lastIndexOf('this.tailStore.update(() => text)')
  check('readTail stages the file’s id into the store before every feed', idAt >= 0 && feedAt > idAt, `setMessageId@${idAt} update@${feedAt}`)
  check('readTail stages the file’s register beside the id, before the feed', phaseAt > idAt && feedAt > phaseAt, `setPhase@${phaseAt}`)
  check('…and reads them from the tail FILE (assign-or-null, never a cached value)', /setMessageId\(typeof tail\.messageId === 'string' && tail\.messageId !== '' \? tail\.messageId : null\)/.test(readTail) && /setPhase\(tail\.phase === 'commentary' \|\| tail\.phase === 'final_answer' \? tail\.phase : null\)/.test(readTail))
  check('detach is a bounded method', detach.length > 0, 'no detach(): void method found')
  const resetAt = detach.indexOf('this.tailStore.reset(null)')
  const dropAt = detach.indexOf('this.tailStore.dropSettled()')
  const idNullAt = detach.indexOf('this.tailStore.setMessageId(null)')
  const phaseNullAt = detach.indexOf('this.tailStore.setPhase(null)')
  check('detach drops the ghost with the tail (a moment, never a cache)', resetAt >= 0 && dropAt > resetAt, `reset@${resetAt} dropSettled@${dropAt}`)
  check('…and zeroes the id and register in the SAME detach, after the drop', idNullAt > dropAt && phaseNullAt > idNullAt, `id@${idNullAt} phase@${phaseNullAt}`)
  check('dropSettled is called nowhere else in the connector (detach is its one scope)', (src.match(/this\.tailStore\.dropSettled\(\)/g) ?? []).length === 1)
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
  check('LiveStreamingTail paints the block\'s register (readPhases → the streaming markdown\'s ink)', leaf.includes('readPhases') && /<StreamingMarkdown[\s\S]{0,160}color=\{ink\}/.test(leaf), 'no register ink on the leaf')
  const law = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/messages/tailRetirement.ts'), 'utf8')
  check('the release law reads no text (identity only)', !/getAssistantMessageText|isHumanTurn/.test(law), 'the text match or the human-turn bound survives in tailRetirement.ts')
}

console.log(
  failures === 0
    ? '\n ✅ ATTACH TAIL IDENTITY — one message, one painted instance, whatever the road in'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
