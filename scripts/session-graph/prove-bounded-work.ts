#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { buildCrewFixture } from './crewFixture.ts'

const t = checker()

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-bounded-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })

const activity = await import('../../src/services/crew/activity.ts')
const conversations = await import('../../src/services/crew/conversations.ts')
const inbox = await import('../../src/services/crew/inbox.ts')

const SEED = 20260801

const nDir = join(scratch, 'n')
const tenDir = join(scratch, 'ten-n')
const fxN = await buildCrewFixture({
  seed: SEED,
  dir: nDir,
  counts: { agents: 8, conversations: 24, conversationEvents: 400, activityEvents: 2_000 },
})
const fxTen = await buildCrewFixture({
  seed: SEED,
  dir: tenDir,
  counts: { agents: 8, conversations: 240, conversationEvents: 4_000, activityEvents: 20_000 },
})

function foldStream(stream: typeof fxN.activityStream): ReturnType<typeof activity.emptyActivityFeed> {
  let feed = activity.emptyActivityFeed()
  for (const input of stream) {
    feed = activity.foldActivity(feed, activity.classifyActivity(input))
  }
  return feed
}

t.section('§1 — the feed window is history-independent')
{
  const feedN = foldStream(fxN.activityStream)
  const feedTen = foldStream(fxTen.activityStream)
  t.check(
    'the retained window holds its cap at N and at 10N',
    feedN.order.length <= activity.ACTIVITY_FEED_CAP && feedTen.order.length <= activity.ACTIVITY_FEED_CAP,
    `${feedN.order.length} / ${feedTen.order.length} (cap ${activity.ACTIVITY_FEED_CAP})`,
  )
  const sliceN = activity.activityRows(feedN).slice(-120)
  const sliceTen = activity.activityRows(feedTen).slice(-120)
  t.check(
    'the rendered viewport slice is the SAME size at N and 10N (window + nothing else)',
    sliceN.length === 120 && sliceTen.length === 120,
    `${sliceN.length} / ${sliceTen.length}`,
  )
  t.check(
    'first useful viewport never requires materializing the raw history (rows ≤ cap ≪ events)',
    feedTen.rows.size <= activity.ACTIVITY_FEED_CAP && fxTen.activityStream.length === 20_000,
  )
}

t.section('§2 — one-row update touches ONE row, independent of history')
{
  const feedTen = foldStream(fxTen.activityStream)
  const before = new Map(feedTen.rows)
  const update = activity.classifyActivity(fxTen.activityStream[fxTen.activityStream.length - 2]!)
  const after = activity.foldActivity(feedTen, update)
  let changed = 0
  for (const [id, row] of after.rows) {
    if (before.get(id) !== row) changed++
  }
  t.check(
    'exactly one row object changed (structural sharing pins the touched set)',
    changed === 1,
    `${changed} rows changed`,
  )
  t.check('the order array is untouched by an in-place update (no scroll jump)', after.order === feedTen.order)
}

t.section('§3 — the inbox fold materializes rows per RETAINED conversation, never per event')
{
  const convsTen = await conversations.listConversations({ dir: tenDir })
  t.check(
    'the conversation store holds its cap at 10N (resolved-first eviction ran)',
    convsTen.length <= 300,
    String(convsTen.length),
  )
  t.check(
    'every retained conversation ring holds its per-thread cap',
    convsTen.every(c => c.events.length <= 100),
  )
  const cursors = await conversations.listReadCursors('op-bounded', { dir: tenDir })
  const rows = inbox.deriveInbox(convsTen, id => cursors.get(id) ?? 0)
  t.check(
    'deriveInbox emits ONE row per retained conversation (never per event)',
    rows.length === convsTen.length,
    `${rows.length} rows / ${convsTen.length} conversations`,
  )

  const capDir = join(scratch, 'over-cap')
  mkdirSync(capDir, { recursive: true })
  const mintedIds: string[] = []
  for (let i = 0; i < 305; i++) {
    const c = await conversations.mintConversation({
      kind: 'work',
      title: `over-cap thread ${String(i).padStart(3, '0')}`,
      participants: [{ kind: 'agent', agentId: fxTen.agentIds[0]! as never }],
      adoptId: `cv-cap-${String(i).padStart(4, '0')}` as never,
      dir: capDir,
    })
    mintedIds.push(c.conversationId as string)
    if (i < 5) {
      await conversations.appendConversationEvent(c.conversationId, { kind: 'question', label: `open ask ${i}`, requiresResolution: true }, { dir: capDir })
    }
  }
  const retained = await conversations.listConversations({ dir: capDir })
  const retainedIds = new Set(retained.map(c => c.conversationId as string))
  const evicted = mintedIds.filter(id => !retainedIds.has(id))
  t.check('over-cap store: 305 minted threads retain exactly the 300-thread cap', retained.length === 300, String(retained.length))
  t.check('over-cap store: exactly five threads were evicted', evicted.length === 5, evicted.join(','))
  t.check(
    'over-cap store: the evicted five are the OLDEST settled threads (5..9), never the five oldest that still owe an answer (0..4) and never the newest',
    evicted.join(',') === [5, 6, 7, 8, 9].map(i => `cv-cap-${String(i).padStart(4, '0')}`).join(',') && [0, 1, 2, 3, 4, 304].every(i => retainedIds.has(`cv-cap-${String(i).padStart(4, '0')}`)),
    evicted.join(','),
  )
  const ringId = mintedIds[304]!
  for (let i = 0; i < 130; i++) {
    await conversations.appendConversationEvent(ringId as never, { kind: i < 3 ? 'question' : 'note', label: `ring ${i}`, ...(i < 3 ? { requiresResolution: true } : {}) } as never, { dir: capDir })
  }
  const ring = (await conversations.listConversations({ dir: capDir })).find(c => (c.conversationId as string) === ringId)!
  const ringLabels = ring.events.map(e => e.label)
  t.check('over-cap ring: 130 appended events retain exactly the 100-event cap', ring.events.length === 100, String(ring.events.length))
  t.check(
    'over-cap ring: the three unresolved asks survive and the thirty evicted events are the oldest settled ones (ring 3..32)',
    ['ring 0', 'ring 1', 'ring 2', 'ring 129'].every(l => ringLabels.includes(l)) && ['ring 3', 'ring 32'].every(l => !ringLabels.includes(l)) && ringLabels.includes('ring 33'),
    ringLabels.slice(0, 6).join(','),
  )
  t.check('over-cap ring: seq never rewinds across eviction (the newest event carries the 130th seq or later)', Math.max(...ring.events.map(e => e.seq)) >= 129, String(Math.max(...ring.events.map(e => e.seq))))
}

t.section('§4 — reconnect work scales with the DELTA, not the history')
{
  const feedTen = foldStream(fxTen.activityStream)
  const before = new Map(feedTen.rows)
  const delta = fxTen.activityStream.slice(0, 50).map((input, i) => ({
    ...input,
    event: { ...input.event, sourceEventId: `delta-${i}`, payload: replaceToolId(input.event.payload, Math.floor(i / 2)) },
  }))
  const deltaIds = new Set(delta.map(input => activity.classifyActivity(input).activityId))
  t.check('the delta is 25 paired tool ids (each start shares its id with the terminal that follows it)', deltaIds.size === 25, `${deltaIds.size} distinct activity ids`)
  let after = feedTen
  for (const input of delta) {
    after = activity.foldActivity(after, activity.classifyActivity(input))
  }
  let changed = 0
  const added: string[] = []
  for (const [id, row] of after.rows) {
    if (before.get(id) !== row) changed++
    if (!before.has(id)) added.push(id)
  }
  t.check(
    'folding a 50-event delta changes ≤ 50 rows regardless of retained history',
    changed <= 50,
    `${changed} rows changed`,
  )
  t.check('the 25 new pairs add exactly 25 new rows, one per pair (start and terminal collapse into ONE row)', added.length === 25 && added.every(id => deltaIds.has(id)), `${added.length} added`)
  t.check('every new row folded its terminal (no pair left running after its result was folded)', added.every(id => after.rows.get(id)?.phase !== 'running'), added.slice(0, 3).map(id => `${id}:${after.rows.get(id)?.phase}`).join(','))
  t.check('the window bound survives the delta', after.order.length <= activity.ACTIVITY_FEED_CAP)
  const replayBefore = after.rows.size
  const replayOrder = after.order
  let replayed = after
  for (const input of fxTen.activityStream.slice(-50)) {
    replayed = activity.foldActivity(replayed, activity.classifyActivity(input))
  }
  t.check(
    'replaying already-folded events adds NO rows (same owner ids collapse in place)',
    replayed.rows.size === replayBefore && replayed.order === replayOrder,
    `${replayed.rows.size} vs ${replayBefore}`,
  )
}

function replaceToolId(payload: unknown, i: number): unknown {
  const p = payload as { message?: { content?: Array<Record<string, unknown>> } } | null
  const content = p?.message?.content
  if (!Array.isArray(content)) return payload
  return {
    ...(payload as Record<string, unknown>),
    message: {
      ...(p!.message as Record<string, unknown>),
      content: content.map(b =>
        b.type === 'tool_use'
          ? { ...b, id: `delta_tool_${i}` }
          : b.type === 'tool_result'
            ? { ...b, tool_use_id: `delta_tool_${i}` }
            : b,
      ),
    },
  }
}

t.finish('prove-bounded-work')
