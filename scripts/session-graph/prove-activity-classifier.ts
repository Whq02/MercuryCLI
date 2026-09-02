#!/usr/bin/env bun
// ============================================================================
//  scripts/session-graph/prove-activity-classifier.ts — the M4 semantic
//  activity laws.
//
//    §1 registry determinism — ordered precedence, unknown fallback LAST
//    §2 stable source ids    — tool start + terminal share ONE row key;
//                              rendered text is never a key
//    §3 table-driven classification — the stream-dialect frame table
//    §4 ACP shapes           — opencode/goose fixture events classify;
//                              kind derivation (edit→file-change, …)
//    §5 truthful unknown     — the codex notification + the future-unknown
//                              adapter fixture land as 'unknown', never
//                              guessed; raw payload retained behind refs
//    §6 in-place collapse    — running→terminal updates ONE row, identity
//                              facts preserved, order stable
//    §7 the bounded feed     — cap drops oldest TERMINAL rows first
//    §8 ingest + line form   — `verb → object → outcome`
//    §9 wave-A regression pins — per-block classification (parallel tool
//       bursts), string-content frames survive, seat-scoped row keys,
//       all-live rows never evicted, status-honest announcements, chunk
//       coalescing
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const activity = await import('../../src/services/crew/activity.ts')
type ActivityInput = import('../../src/services/crew/activity.ts').ActivityInput

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`scripts/session-graph/fixtures/${name}.fixture.json`, 'utf8'))

const AGENT = 'cw-000000000fff' as never
let seq = 0
const input = (payload: unknown, kind: string, adapterKind = 'codex'): ActivityInput => ({
  event: { sourceEventId: `fx-${++seq}`, kind, payload, atMs: 1_000_000 + seq },
  agentId: AGENT,
  sessionId: 'fx-session',
  adapterKind,
})

const kindOfStreamFrame = (p: Record<string, unknown>): string =>
  p.type === 'system' ? `system.${String(p.subtype)}` : String(p.type)

t.section('§1 — registry determinism')
{
  const order = activity.activityClassifierOrder()
  const sorted = [...order].sort((a, b) => a.precedence - b.precedence || (a.name < b.name ? -1 : 1))
  t.check('the registry is precedence-ordered', JSON.stringify(order) === JSON.stringify(sorted))
  t.check('the unknown fallback is LAST and cannot be outranked', order.at(-1)?.name === 'unknown-raw')
  t.check(
    'ACTIVITY_CLASSES is exactly the twelve Mercury classes',
    activity.ACTIVITY_CLASSES.length === 12 && activity.ACTIVITY_CLASSES.at(-1) === 'unknown',
  )
}

t.section('§2 — stable source ids')
{
  const start = input(
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Edit', input: { file_path: 'src/a.ts' } }] } },
    'assistant',
  )
  const end = input(
    { type: 'user', message: { id: 'm2', content: [{ type: 'tool_result', tool_use_id: 'toolu_x' }] } },
    'user',
  )
  t.check(
    'tool start and terminal frames share ONE row key (the tool-call id)',
    activity.activityIdOf(start) === activity.activityIdOf(end),
    `${activity.activityIdOf(start)} vs ${activity.activityIdOf(end)}`,
  )
  const textA = input({ type: 'assistant', message: { id: 'mA', content: [{ type: 'text', text: 'same words' }] } }, 'assistant')
  const textB = input({ type: 'assistant', message: { id: 'mB', content: [{ type: 'text', text: 'same words' }] } }, 'assistant')
  t.check(
    'identical rendered text still keys DIFFERENT rows (ids, never text)',
    activity.activityIdOf(textA) !== activity.activityIdOf(textB),
  )
}

t.section('§3 — table-driven classification (the stream-dialect frame table)')
{
  // Five inline stream-dialect frames — one per classification law. (The
  // external-capture fixture retired with its seat; the LAWS are dialect
  // facts, so the table carries its own neutral frames.)
  const events: Array<Record<string, unknown>> = [
    { type: 'system', subtype: 'init', session_id: 'fx-session-1', tools: ['Bash', 'Edit'], model: 'model-a' },
    { type: 'assistant', session_id: 'fx-session-1', message: { id: 'msg_fx1', role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
    { type: 'assistant', session_id: 'fx-session-1', message: { id: 'msg_fx2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fx1', name: 'Edit', input: { file_path: 'src/foo.ts' } }] } },
    { type: 'user', session_id: 'fx-session-1', message: { id: 'msg_fx3', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', session_id: 'fx-session-1', usage: { input_tokens: 1200, output_tokens: 80 }, total_cost_usd: 0.01 },
  ]
  const want: Array<[cls: string, verb: string]> = [
    // The init frame is the (re)connection moment — the
    // session-connect classifier (precedence 243) outranks the generic
    // lifecycle 'announced' row for system.init frames.
    ['session-lifecycle', 'connected'],
    ['message', 'said'],
    ['file-change', 'edited'],
    ['tool', 'finished'],
    ['session-lifecycle', 'settled'],
  ]
  events.forEach((frame, ix) => {
    const row = activity.classifyActivity(input(frame, kindOfStreamFrame(frame)))
    const [cls, verb] = want[ix]!
    t.check(
      `fixture event ${ix} (${String(frame.type)}) → ${cls}/${verb}`,
      row.class === cls && row.verb === verb,
      `${row.class}/${row.verb}`,
    )
  })
  const bash = activity.classifyActivity(
    input(
      { type: 'assistant', message: { id: 'mb', content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'git status' } }] } },
      'assistant',
    ),
  )
  t.check('a Bash tool_use classifies as command/ran', bash.class === 'command' && bash.verb === 'ran')
  const check = activity.classifyActivity(
    input(
      { type: 'assistant', message: { id: 'mc', content: [{ type: 'tool_use', id: 'tc', name: 'Bash', input: { command: 'bun run typecheck' } }] } },
      'assistant',
    ),
  )
  t.check('a check-shaped command outranks generic command (precedence)', check.class === 'check')
  const ask = activity.classifyActivity(
    input(
      { type: 'assistant', message: { id: 'mq', content: [{ type: 'tool_use', id: 'tq', name: 'AskUserQuestion', input: {} }] } },
      'assistant',
    ),
  )
  t.check('AskUserQuestion → question/asked→you/waiting', ask.class === 'question' && ask.objectLabel === 'you' && ask.phase === 'waiting')
}

t.section('§4 — ACP shapes (opencode/goose fixtures)')
{
  for (const name of ['opencode', 'goose'] as const) {
    const events = fixture(name).events as Array<Record<string, unknown>>
    const rows = events.map(e =>
      activity.classifyActivity(input(e.params, String(e.method), name)),
    )
    t.check(`${name}: tool_call (kind read) → tool/read`, rows[0]!.class === 'tool' && rows[0]!.verb === 'read')
    t.check(`${name}: tool_call_update shares the row key with its start`,
      activity.activityIdOf(input(events[0]!.params, 'session/update', name)) ===
      activity.activityIdOf(input(events[1]!.params, 'session/update', name)))
    t.check(`${name}: agent_message_chunk → message/said`, rows[2]!.class === 'message' && rows[2]!.verb === 'said')
  }
  const edit = activity.classifyActivity(
    input(
      { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'tce', title: 'edit src/x.ts', status: 'in_progress', kind: 'edit' } },
      'session/update',
      'opencode',
    ),
  )
  t.check('ACP kind edit derives file-change/edited', edit.class === 'file-change' && edit.verb === 'edited')
}

t.section('§5 — truthful unknown')
{
  const codexEvents = fixture('codex').events as Array<Record<string, unknown>>
  // The fixture must CARRY the leg — an emptied events array would silently
  // drop the unknown-classification check below (final audit).
  t.check('the codex fixture carries at least one replayable notification', codexEvents.length > 0, String(codexEvents.length))
  if (codexEvents.length > 0) {
    const row = activity.classifyActivity(
      input(codexEvents[0]!.params ?? codexEvents[0], String(codexEvents[0]!.method ?? 'notification'), 'codex'),
    )
    t.check(
      'an unrecognized codex notification lands as unknown (never guessed)',
      row.class === 'unknown' && /unclassified/.test(row.outcomeLabel ?? ''),
      `${row.class}`,
    )
  }
  const future = activity.classifyActivity(
    input({ totally: 'novel', shape: { with: ['nested', 'stuff'] } }, 'future/adapter-event', 'future-adapter'),
  )
  t.check('a future unknown adapter event stays one truthful generic row', future.class === 'unknown')
  t.check('the raw payload stays reachable behind refs (no discard)', future.rawRefs.length === 1)
}

t.section('§6 — in-place collapse preserves identity facts')
{
  let feed = activity.emptyActivityFeed()
  const start = activity.classifyActivity(
    input(
      { type: 'assistant', message: { id: 'ms', content: [{ type: 'tool_use', id: 'toolu_c', name: 'Edit', input: { file_path: 'src/collapse.ts' } }] } },
      'assistant',
    ),
  )
  feed = activity.foldActivity(feed, start)
  const midOrder = [...feed.order]
  const terminal = activity.classifyActivity(
    input(
      { type: 'user', message: { id: 'mt', content: [{ type: 'tool_result', tool_use_id: 'toolu_c' }] } },
      'user',
    ),
  )
  feed = activity.foldActivity(feed, terminal)
  t.check('one row, not two (the running row became its outcome)', feed.rows.size === 1)
  const row = activity.activityRows(feed)[0]!
  t.check('identity facts preserved (still edited → src/collapse.ts)', row.class === 'file-change' && row.objectLabel === 'src/collapse.ts')
  t.check('the phase advanced to the terminal outcome', row.phase === 'succeeded')
  t.check('order is stable across the update (no scroll-jump material)', JSON.stringify(feed.order) === JSON.stringify(midOrder))
  t.check('both raw frames remain referenced (no source-event discard)', row.rawRefs.length === 2)
}

t.section('§7 — the bounded feed drops oldest TERMINAL rows first')
{
  let feed = activity.emptyActivityFeed()
  // One live row first, then flood past the cap with terminal rows.
  const live = activity.classifyActivity(
    input(
      { type: 'assistant', message: { id: 'ml', content: [{ type: 'tool_use', id: 'toolu_live', name: 'Edit', input: { file_path: 'src/live.ts' } }] } },
      'assistant',
    ),
  )
  feed = activity.foldActivity(feed, live)
  for (let i = 0; i < activity.ACTIVITY_FEED_CAP + 5; i++) {
    feed = activity.foldActivity(
      feed,
      activity.classifyActivity(
        input({ type: 'assistant', message: { id: `mf${i}`, content: [{ type: 'text', text: `line ${i}` }] } }, 'assistant'),
      ),
    )
  }
  t.check('the window stays bounded', feed.order.length <= activity.ACTIVITY_FEED_CAP)
  t.check('the LIVE row survived the flood (terminal rows dropped first)', feed.rows.has(live.activityId))
}

t.section('§8 — ingest + the line form')
{
  activity._resetActivityFeedForTesting()
  let pings = 0
  const unsub = activity.subscribeActivityFeed(() => pings++)
  const rows = activity.ingestActivity(
    input(
      { type: 'assistant', message: { id: 'mi', content: [{ type: 'tool_use', id: 'toolu_i', name: 'Bash', input: { command: 'bun run typecheck' } }] } },
      'assistant',
    ),
  )
  t.check('ingest folds into the live feed and notifies once', pings === 1 && activity.cachedActivityFeed().rows.size === 1)
  t.check(
    'the line reads verb → object → outcome',
    activity.activityLineOf(rows[0]!, 'Atlas') === 'Atlas · ran → bun run typecheck → running',
    activity.activityLineOf(rows[0]!, 'Atlas'),
  )
  unsub()
  activity._resetActivityFeedForTesting()
}

t.section('§9 — wave-A regression pins')
{
  // A parallel tool burst is ONE frame with several tool_use blocks — each
  // block gets its OWN row (the second call never vanishes behind the first).
  activity._resetActivityFeedForTesting()
  let pings = 0
  const unsub = activity.subscribeActivityFeed(() => pings++)
  const burst = activity.ingestActivity(
    input(
      {
        type: 'assistant',
        message: {
          id: 'mburst',
          content: [
            { type: 'tool_use', id: 'tp_a', name: 'Edit', input: { file_path: 'src/a.ts' } },
            { type: 'tool_use', id: 'tp_b', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
      },
      'assistant',
    ),
  )
  t.check(
    'a parallel burst mints one row PER tool call (2 rows, 1 notify)',
    burst.length === 2 && activity.cachedActivityFeed().rows.size === 2 && pings === 1,
    `${burst.length} rows`,
  )
  t.check(
    'each burst row keeps its own identity (file-change + check)',
    burst[0]!.class === 'file-change' && burst[1]!.class === 'check',
    `${burst[0]!.class}/${burst[1]!.class}`,
  )
  const bTerminal = activity.ingestActivity(
    input(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tp_b', is_error: true }] } },
      'user',
    ),
  )
  const bRow = [...activity.cachedActivityFeed().rows.values()].find(r => r.activityId.endsWith(':tool:tp_b'))
  t.check(
    "the second call's terminal folds into ITS row (still a check, now failed)",
    bTerminal.length === 1 && activity.cachedActivityFeed().rows.size === 2 && bRow?.class === 'check' && bRow.phase === 'failed',
    `${String(bRow?.class)}/${String(bRow?.phase)}`,
  )
  unsub()
  activity._resetActivityFeedForTesting()

  // A `[text, tool_use]` frame keeps BOTH facts: a message row and a tool row.
  const mixed = activity.ingestActivity(
    input(
      {
        type: 'assistant',
        message: {
          id: 'mmix',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'tp_m', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      'assistant',
    ),
  )
  t.check(
    'a text+tool frame yields a message row AND a tool row',
    mixed.length === 2 && mixed.some(r => r.class === 'message') && mixed.some(r => r.class === 'command'),
  )
  activity._resetActivityFeedForTesting()

  // A string-content user frame is a LEGAL wire shape — it classifies (as the
  // message it is), it is never dropped and never throws.
  const stringContent = activity.classifyActivity(
    input({ type: 'user', message: { role: 'user', content: 'hi there' } }, 'user'),
  )
  t.check(
    'a string-content user frame lands truthfully (message, not a crash)',
    stringContent.class === 'message' && stringContent.objectLabel === 'hi there',
    `${stringContent.class}/${stringContent.objectLabel}`,
  )

  // Row keys are SEAT-scoped: the same session-unique tool-call id from two
  // different sessions of one adapter kind never fold into one row.
  const seatA: ActivityInput = {
    event: { sourceEventId: 'sA-1', kind: 'session/update', payload: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'read', status: 'completed' } }, atMs: 1 },
    agentId: 'cw-00000000000a' as never,
    sessionId: 'session-A',
    adapterKind: 'goose',
  }
  const seatB: ActivityInput = { ...seatA, agentId: 'cw-00000000000b' as never, sessionId: 'session-B' }
  t.check(
    'the same tool-call id in two sessions keys two DIFFERENT rows',
    activity.activityIdOf(seatA) !== activity.activityIdOf(seatB),
    `${activity.activityIdOf(seatA)} vs ${activity.activityIdOf(seatB)}`,
  )

  // All-live flood: live rows are NEVER dropped — the window may temporarily
  // exceed the cap while no terminal victim exists.
  let feed = activity.emptyActivityFeed()
  for (let i = 0; i < activity.ACTIVITY_FEED_CAP + 3; i++) {
    feed = activity.foldActivity(
      feed,
      activity.classifyActivity(
        input(
          { type: 'assistant', message: { id: `mlive${i}`, content: [{ type: 'tool_use', id: `tl${i}`, name: 'Edit', input: { file_path: `f${i}.ts` } }] } },
          'assistant',
        ),
      ),
    )
  }
  t.check(
    'an all-live flood evicts NOTHING (the stated law, not the silent fallback)',
    feed.order.length === activity.ACTIVITY_FEED_CAP + 3 &&
      activity.activityRows(feed).every(r => r.phase === 'running'),
    String(feed.order.length),
  )

  // Announcements carry their OWN status — a failed task notification never
  // renders 'succeeded'.
  const failedNotification = activity.classifyActivity(
    input({ type: 'system', subtype: 'task_notification', status: 'failed', summary: 'x' }, 'system.task_notification'),
  )
  t.check(
    'a failed task notification lands phase=failed with the status label',
    failedNotification.phase === 'failed' && failedNotification.outcomeLabel === 'failed',
    `${failedNotification.phase}/${String(failedNotification.outcomeLabel)}`,
  )

  // ACP message chunks coalesce into ONE session-stream row whose label
  // extends fragment by fragment.
  let chunkFeed = activity.emptyActivityFeed()
  const chunk = (text: string, seq: number): ActivityInput => ({
    event: { sourceEventId: `session/update-${seq}`, kind: 'session/update', payload: { update: { sessionUpdate: 'agent_message_chunk', content: { text } } }, atMs: 100 + seq },
    agentId: 'cw-00000000000c' as never,
    sessionId: 'chunk-session',
    adapterKind: 'opencode',
  })
  chunkFeed = activity.foldActivity(chunkFeed, activity.classifyActivity(chunk('The fix ', 1)))
  chunkFeed = activity.foldActivity(chunkFeed, activity.classifyActivity(chunk('is in foo.ts', 2)))
  const chunkRow = activity.activityRows(chunkFeed)[0]!
  t.check(
    'two chunks fold into ONE row with the label extended (no per-chunk flood)',
    chunkFeed.rows.size === 1 && chunkRow.objectLabel === 'The fix is in foo.ts' && chunkRow.rawRefs.length === 2,
    `${String(chunkFeed.rows.size)} rows · '${chunkRow.objectLabel}'`,
  )
}

t.finish('prove-activity-classifier')
