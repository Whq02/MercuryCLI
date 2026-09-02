#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-bounded-work.ts — the M9 deterministic
//  bounded-work laws. STRUCTURAL counters, never wall-clock: the
//  same viewport at history N and 10N must read/materialize only the bounded
//  window plus delta — the caps and the fold's structural sharing ARE the
//  law, so CI enforces it deterministically on any host.
//
//    §1 the feed window     — 10× the event stream, the SAME retained bound
//                             and the SAME rendered slice size
//    §2 one-row update      — a single ingest changes exactly ONE row object
//                             (structural sharing pins the touched set),
//                             independent of retained history
//    §3 the inbox fold      — conversations and their event rings hold their
//                             caps at 10N; deriveInbox materializes one row
//                             per retained conversation, never per event
//    §4 reconnect delta     — folding a K-event delta changes ≤ K rows
//                             regardless of the history already retained
// ============================================================================

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

// N and 10N fixtures in separate scratch stores, same seed discipline.
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
}

t.section('§4 — reconnect work scales with the DELTA, not the history')
{
  const feedTen = foldStream(fxTen.activityStream)
  const before = new Map(feedTen.rows)
  // A 50-event delta (25 new tool pairs) — the reconnect fold.
  const delta = fxTen.activityStream.slice(0, 50).map((input, i) => ({
    ...input,
    event: { ...input.event, sourceEventId: `delta-${i}`, payload: replaceToolId(input.event.payload, i) },
  }))
  let after = feedTen
  for (const input of delta) {
    after = activity.foldActivity(after, activity.classifyActivity(input))
  }
  let changed = 0
  for (const [id, row] of after.rows) {
    if (before.get(id) !== row) changed++
  }
  t.check(
    'folding a 50-event delta changes ≤ 50 rows regardless of retained history',
    changed <= 50,
    `${changed} rows changed`,
  )
  t.check('the window bound survives the delta', after.order.length <= activity.ACTIVITY_FEED_CAP)
  // REPLAYING already-folded events (the reconnect-overlap case, same ids)
  // adds NO rows and keeps the order array untouched — replayed terminals
  // collapse into their existing rows instead of duplicating (wave B).
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
